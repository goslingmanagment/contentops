import {
  ITEM_TYPE_INFO,
  type ItemType,
  ItemTypeSchema,
} from '@contentops/contracts/domain/item-type'
import type { Threshold, ThresholdKey, ThresholdScope } from '@contentops/contracts/domain/system'
import { logAction, type Queryable, type Tx, type values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { checkVersion } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'

/**
 * «Пороги» (DESIGN §4.19): one `policy_settings` row per key and scope; no row or SQL NULL —
 * not set, the function is off; there are no seeds. The screen's keys map onto the keys of
 * schema §3.1; values are kept in the screen's units.
 */
const THRESHOLDS: Record<
  ThresholdKey,
  { key: (typeof values.thresholdKeys)[number]; label: string; unit: string }
> = {
  too_early_days: { key: 'too_early_days', label: '«Слишком рано»', unit: 'дней' },
  time_tolerance_min: { key: 'hub_candidate_tolerance', label: 'Допуск времени', unit: 'мин' },
  duration_tolerance_ms: {
    key: 'hub_exact_duration_ms',
    label: 'Допуск длительности',
    unit: 'мс',
  },
  wait_hub_hours: { key: 'hub_wait_window', label: '«Ждём Hub»', unit: 'ч' },
  not_published_hours: { key: 'hub_not_out_window', label: '«Не вышло»', unit: 'ч' },
  album_walk_reminder_days: {
    key: 'hub_vault_recheck',
    label: 'Напоминание обхода альбома',
    unit: 'дней',
  },
  frame_similarity: { key: 'phash_suggest_threshold', label: 'Похожесть кадров', unit: '%' },
  auto_accept: { key: 'intake_auto_accept', label: 'Автопринятие', unit: '' },
}

const SCREEN_KEYS = Object.keys(THRESHOLDS) as ThresholdKey[]

const ITEM_TYPE_BY_PREFIX = Object.fromEntries(
  Object.entries(ITEM_TYPE_INFO).map(([type, info]) => [info.prefix, type as ItemType]),
)

interface PolicyRow extends Record<string, unknown> {
  id: string
  key: string
  model_code: string | null
  account_code: string | null
  item_type: string | null
  value: unknown
  row_version: number | string
}

/** Scope of a stored row as the screen knows it; other combinations are not shown. */
function scopeOf(row: PolicyRow): { scope: ThresholdScope; value: string | null } | null {
  if (row.account_code && !row.item_type) return { scope: 'account', value: row.account_code }
  if (row.model_code && !row.account_code && !row.item_type) {
    return { scope: 'model', value: row.model_code }
  }
  if (!row.model_code && row.item_type) {
    return { scope: 'type', value: ITEM_TYPE_BY_PREFIX[row.item_type] ?? null }
  }
  if (!row.model_code && !row.item_type) return { scope: 'all', value: null }
  return null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

async function rows(q: Queryable, lock = false): Promise<PolicyRow[]> {
  const { rows: list } = await q.execute<PolicyRow>(sql`
    SELECT s.id, s.key, m.code AS model_code, a.code AS account_code, s.item_type, s.value,
           s.row_version
      FROM policy_settings s
      LEFT JOIN models m ON m.id = s.model_id
      LEFT JOIN accounts a ON a.model_id = s.model_id AND a.id = s.account_id
     WHERE s.key = ANY(${sql.param(SCREEN_KEYS.map((key) => THRESHOLDS[key].key))}::text[])
     ORDER BY s.created_at, s.id
     ${lock ? sql`FOR UPDATE OF s` : sql``}`)
  return list
}

/** Every key has its row for everything, stored or not; exceptions follow it. */
function thresholdList(stored: readonly PolicyRow[]): Threshold[] {
  return SCREEN_KEYS.flatMap((key) => {
    const meta = THRESHOLDS[key]
    const mine = stored.flatMap((row) => {
      const scope = row.key === meta.key ? scopeOf(row) : null
      return scope ? [{ row, ...scope }] : []
    })
    const all = mine.find((entry) => entry.scope === 'all')
    const make = (entry: (typeof mine)[number]): Threshold => ({
      key,
      label: meta.label,
      unit: meta.unit,
      value: numberOf(entry.row.value),
      scope: entry.scope,
      scope_value: entry.value,
      version: Number(entry.row.row_version),
    })
    const unset: Threshold = {
      key,
      label: meta.label,
      unit: meta.unit,
      value: null,
      scope: 'all',
      scope_value: null,
      version: 1,
    }
    return [all ? make(all) : unset, ...mine.filter((entry) => entry.scope !== 'all').map(make)]
  })
}

/** Every threshold with its exceptions, as the screen and the plan rules read them. */
export async function readThresholds(q: Queryable): Promise<Threshold[]> {
  return thresholdList(await rows(q))
}

interface Target {
  modelId: string | null
  accountId: string | null
  itemType: string | null
  /** « для страницы Fansly 2»; empty for everything. */
  where: string
}

async function targetOf(
  q: Queryable,
  scope: ThresholdScope,
  value: string | null,
): Promise<Target> {
  if (scope === 'all' || value === null) {
    return { modelId: null, accountId: null, itemType: null, where: '' }
  }
  if (scope === 'type') {
    const type = ItemTypeSchema.safeParse(value)
    if (!type.success) throw new ApiProblem('invalid_request', 'Такого типа нет')
    const info = ITEM_TYPE_INFO[type.data]
    return {
      modelId: null,
      accountId: null,
      itemType: info.prefix,
      where: ` для типа «${info.folder}»`,
    }
  }
  if (scope === 'model') {
    const { rows: found } = await q.execute<{ id: string; name: string }>(sql`
      SELECT id, title AS name FROM models WHERE code = ${value}`)
    const model = found[0]
    if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
    return {
      modelId: model.id,
      accountId: null,
      itemType: null,
      where: ` для модели ${model.name}`,
    }
  }
  const { rows: found } = await q.execute<{ id: string; model_id: string; title: string }>(sql`
    SELECT id, model_id, title FROM accounts WHERE code = ${value}`)
  const account = found[0]
  if (!account) throw new ApiProblem('not_found', 'Такой страницы нет')
  return {
    modelId: account.model_id,
    accountId: account.id,
    itemType: null,
    where: ` для страницы ${account.title}`,
  }
}

async function storedRow(tx: Tx, key: string, target: Target): Promise<PolicyRow | undefined> {
  const { rows: found } = await tx.execute<PolicyRow>(sql`
    SELECT id, key, NULL AS model_code, NULL AS account_code, item_type, value, row_version
      FROM policy_settings
     WHERE key = ${key}
       AND model_id IS NOT DISTINCT FROM ${target.modelId}::uuid
       AND account_id IS NOT DISTINCT FROM ${target.accountId}::uuid
       AND item_type IS NOT DISTINCT FROM ${target.itemType}
     FOR UPDATE`)
  return found[0]
}

function valueWord(value: number | null): string {
  return value === null ? 'не задано' : String(value)
}

function viewOf(
  key: ThresholdKey,
  scope: ThresholdScope,
  scopeValue: string | null,
  row: PolicyRow,
): Threshold {
  return {
    key,
    label: THRESHOLDS[key].label,
    unit: THRESHOLDS[key].unit,
    value: numberOf(row.value),
    scope,
    scope_value: scopeValue,
    version: Number(row.row_version),
  }
}

export function thresholdHandlers({ db, command }: Services): HandlerRegistry {
  return {
    admin: {
      thresholds: async () => ({ items: thresholdList(await rows(db)), next_cursor: null }),

      updateThreshold: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const meta = THRESHOLDS[body.key]
          const target = await targetOf(tx, body.scope, body.scope_value)
          const existing = await storedRow(tx, meta.key, target)
          const field = `${meta.label}${target.where}`
          // SQL NULL — not set; JSON null never reaches the column (schema §3.1).
          const value = body.value === null ? null : JSON.stringify(body.value)
          let row: PolicyRow | undefined
          let before: number | null
          if (existing) {
            await checkVersion(
              tx,
              ctx,
              {
                version: Number(existing.row_version),
                subjectKind: 'policy_settings',
                subjectId: existing.id,
                field,
              },
              () => numberOf(existing.value),
            )
            before = numberOf(existing.value)
            const { rows: updated } = await tx.execute<PolicyRow>(sql`
              UPDATE policy_settings
                 SET value = ${value}::jsonb, updated_at = now(), updated_by = ${actor.id}::uuid,
                     row_version = row_version + 1
               WHERE id = ${existing.id}::uuid
              RETURNING id, key, NULL AS model_code, NULL AS account_code, item_type, value,
                        row_version`)
            row = updated[0]
          } else {
            // The row for everything exists from the start at version 1 without a stored row;
            // an exception is new and is created without `If-Match`.
            if (body.scope === 'all') {
              await checkVersion(
                tx,
                ctx,
                { version: 1, subjectKind: 'policy_settings', subjectId: meta.key, field },
                () => null,
              )
            } else if (ctx.ifMatch !== null) {
              throw new ApiProblem('not_found', 'Этого исключения уже нет')
            }
            before = null
            const { rows: inserted } = await tx.execute<PolicyRow>(sql`
              INSERT INTO policy_settings
                (model_id, account_id, item_type, key, value, updated_by, row_version)
              VALUES (${target.modelId}::uuid, ${target.accountId}::uuid, ${target.itemType},
                      ${meta.key}, ${value}::jsonb, ${actor.id}::uuid,
                      ${body.scope === 'all' ? 2 : 1})
              ON CONFLICT ON CONSTRAINT policy_settings_scope DO NOTHING
              RETURNING id, key, NULL AS model_code, NULL AS account_code, item_type, value,
                        row_version`)
            row = inserted[0]
            if (!row) throw new ApiProblem('version_mismatch', 'Запись уже изменили')
          }
          if (!row) throw new Error('threshold write returned nothing')
          await logAction(tx, {
            modelId: target.modelId,
            subjectKind: 'policy_settings',
            subjectId: row.id,
            subjectLabel: field,
            before: { [meta.label]: existing ? valueWord(before) : 'не задано' },
            after: { [meta.label]: valueWord(body.value) },
          })
          return viewOf(body.key, body.scope, body.scope_value, row)
        }),

      removeThreshold: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          if (body.scope === 'all') {
            throw new ApiProblem(
              'invalid_request',
              'Порог для всего не убирается: пустое значение выключает функцию',
            )
          }
          const meta = THRESHOLDS[body.key]
          const target = await targetOf(tx, body.scope, body.scope_value)
          const existing = await storedRow(tx, meta.key, target)
          if (!existing) throw new ApiProblem('not_found', 'Этого исключения уже нет')
          const field = `${meta.label}${target.where}`
          await checkVersion(
            tx,
            ctx,
            {
              version: Number(existing.row_version),
              subjectKind: 'policy_settings',
              subjectId: existing.id,
              field,
            },
            () => numberOf(existing.value),
          )
          await tx.execute(sql`DELETE FROM policy_settings WHERE id = ${existing.id}::uuid`)
          await logAction(tx, {
            modelId: target.modelId,
            subjectKind: 'policy_settings',
            subjectId: existing.id,
            subjectLabel: field,
            before: { [meta.label]: valueWord(numberOf(existing.value)) },
            after: { [meta.label]: 'как для всего' },
          })
          return { ok: true as const }
        }),
    },
  }
}
