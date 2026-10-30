import type { UpdateWeekNormCommand } from '@contentops/contracts/commands/plan'
import { UNIQ_LEVEL_LABEL } from '@contentops/contracts/domain/model'
import { type NormKind, type WeekNorm, WeekNormSchema } from '@contentops/contracts/domain/plan'
import { logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { checkVersion } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Snapshot } from '../journal/describe'
import type { Services } from '../services'

/**
 * Week norm of a page (SPEC §4, DESIGN §4.14): `accounts.week_norm` holds the cells and the
 * PPV release as JSON with its schema version; «обычно выкладывает» and the FYP version
 * level are the page's columns. The version of the norm is the page's `row_version`.
 */

export const NORM_SCHEMA_VERSION = 1

const StoredNormSchema = z.object({
  schema_version: z.literal(NORM_SCHEMA_VERSION),
  cells: WeekNormSchema.shape.cells,
  release: WeekNormSchema.shape.release,
})
type StoredNorm = z.infer<typeof StoredNormSchema>

interface AccountRow extends Record<string, unknown> {
  id: string
  code: string
  title: string
  platform: 'fansly' | 'onlyfans'
  week_norm: unknown
  default_assignee_id: string | null
  default_uniq_level: WeekNorm['uniq_level'] | null
  row_version: number | string
}

/** A page without a norm yet: zero in every cell. FYP exists only on Fansly. */
function emptyNorm(platform: AccountRow['platform']): StoredNorm {
  const kinds: NormKind[] =
    platform === 'fansly' ? ['fyp', 'wall', 'life_vault'] : ['wall', 'life_vault']
  return {
    schema_version: NORM_SCHEMA_VERSION,
    cells: kinds.map((kind) => ({ kind, per_day: [0, 0, 0, 0, 0, 0, 0], time: null })),
    release: null,
  }
}

function normOf(row: AccountRow): WeekNorm {
  const stored =
    row.week_norm === null ? emptyNorm(row.platform) : StoredNormSchema.parse(row.week_norm)
  return {
    account: row.code,
    cells: stored.cells,
    release: stored.release,
    usual_assignee: row.default_assignee_id,
    uniq_level: row.default_uniq_level ?? 'soft',
    version: Number(row.row_version),
  }
}

async function pageOf(q: Queryable, model: ModelScope, code: string, lock: boolean) {
  const { rows } = await q.execute<AccountRow>(sql`
    SELECT id, code, title, platform, week_norm, default_assignee_id, default_uniq_level,
           row_version
      FROM accounts
     WHERE model_id = ${model.id}::uuid AND code = ${code} AND archived_at IS NULL
     ${lock ? sql`FOR UPDATE` : sql``}`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такой страницы нет')
  return row
}

/** «Обычно выкладывает» — a person with rights on the model, or nobody. */
async function checkAssignee(tx: Tx, model: ModelScope, id: string | null): Promise<string | null> {
  if (id === null) return null
  const { rows } = await tx.execute<{ name: string }>(sql`
    SELECT p.display_name AS name FROM principals p
     WHERE p.id::text = ${id} AND p.kind = 'human' AND p.disabled_at IS NULL
       AND (p.role = 'owner' OR EXISTS (
             SELECT 1 FROM principal_grants g
              WHERE g.principal_id = p.id AND g.model_id = ${model.id}::uuid
                AND g.revoked_at IS NULL))`)
  const row = rows[0]
  if (!row) {
    throw new ApiProblem('invalid_request', 'Такого человека нет у модели', {
      field: 'usual_assignee',
    })
  }
  return row.name
}

async function nameOf(q: Queryable, id: string | null): Promise<string | null> {
  if (id === null) return null
  const { rows } = await q.execute<{ name: string }>(sql`
    SELECT display_name AS name FROM principals WHERE id = ${id}::uuid`)
  return rows[0]?.name ?? null
}

const KIND_SHORT: Record<NormKind, string> = {
  fyp: 'Фуп',
  wall: 'Стена',
  life_vault: 'Лайф в vault',
  story: 'Сториз',
}
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

function everyWeeks(weeks: number): string {
  if (weeks === 1) return 'каждую неделю'
  return `раз в ${weeks} ${weeks < 5 ? 'недели' : 'недель'}`
}

/** The norm in words for «было → стало»: one field per non-empty cell, time and extras. */
function normSnapshot(
  norm: Omit<WeekNorm, 'account' | 'version'>,
  assignee: string | null,
): Snapshot {
  const fields: Snapshot = {}
  for (const cell of norm.cells) {
    cell.per_day.forEach((count, day) => {
      if (count > 0) fields[`${KIND_SHORT[cell.kind]} · ${WEEKDAYS[day]}`] = String(count)
    })
    if (cell.time) fields[`${KIND_SHORT[cell.kind]} · время`] = cell.time
  }
  if (norm.release) {
    const { every_weeks, weekday, time } = norm.release
    fields['Выпуск PPV'] = `${everyWeeks(every_weeks)} · ${WEEKDAYS[weekday]} · ${time}`
  }
  fields['Обычно выкладывает'] = assignee ?? 'никто'
  fields['Уровень версий фупа'] = UNIQ_LEVEL_LABEL[norm.uniq_level]
  return fields
}

function checkCells(norm: UpdateWeekNormCommand): void {
  const kinds = norm.cells.map((cell) => cell.kind)
  if (new Set(kinds).size !== kinds.length) {
    throw new ApiProblem('invalid_request', 'Тип нормы повторяется', { field: 'cells' })
  }
}

export function normHandlers({ db, command }: Services): HandlerRegistry {
  const modelOf = (model: ModelScope | null): ModelScope => {
    if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
    return model
  }
  return {
    plan: {
      norm: async ({ params, ctx }) =>
        normOf(await pageOf(db, modelOf(ctx.model), params.account, false)),

      updateNorm: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          const row = await pageOf(tx, model, params.account, true)
          const before = normOf(row)
          await checkVersion(
            tx,
            ctx,
            {
              version: before.version,
              subjectKind: 'accounts',
              subjectId: row.id,
              field: 'норма недели',
            },
            () => before,
          )
          checkCells(body)
          const beforeAssignee = await nameOf(tx, before.usual_assignee)
          const assignee = await checkAssignee(tx, model, body.usual_assignee)
          const stored: StoredNorm = {
            schema_version: NORM_SCHEMA_VERSION,
            cells: body.cells,
            release: body.release,
          }
          const { rows } = await tx.execute<AccountRow>(sql`
            UPDATE accounts
               SET week_norm = ${JSON.stringify(stored)}::jsonb,
                   default_assignee_id = ${body.usual_assignee}::uuid,
                   default_uniq_level = ${body.uniq_level},
                   row_version = row_version + 1
             WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid
            RETURNING id, code, title, platform, week_norm, default_assignee_id,
                      default_uniq_level, row_version`)
          const updated = rows[0]
          if (!updated) throw new Error('norm update returned nothing')
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'accounts',
            subjectId: row.id,
            subjectLabel: row.title,
            before: normSnapshot(before, beforeAssignee),
            after: normSnapshot(body, assignee),
          })
          return normOf(updated)
        }),
    },
  }
}
