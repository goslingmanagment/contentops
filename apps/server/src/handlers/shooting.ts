import { mskDate } from '@contentops/contracts/clock'
import type { ShootingTask, ShootingTaskList } from '@contentops/contracts/domain/shooting'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { instant } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { actorRefs } from '../orders/view'
import type { Services } from '../services'

/**
 * «Съёмка › ТЗ» (products plan 15.11.2026 §2.4, package C3): a task for the model that is not a
 * fan's order — a set, a batch of FYP — with a deadline and a hand-in, kept here. The owner and a
 * content manager make and close them; «Только чтение» reads them.
 */

interface TaskRow extends Record<string, unknown> {
  id: string
  title: string
  kind: ShootingTask['kind']
  note: string | null
  deadline_on: string | null
  created_at: string
  created_by: string
  handed_in_at: string | null
  handed_in_by: string | null
}

const COLUMNS = sql`id, title, kind, note, deadline_on::text AS deadline_on, created_at::text AS created_at,
  created_by, handed_in_at::text AS handed_in_at, handed_in_by`

const DONE_DAYS = 14

async function views(q: Queryable, rows: readonly TaskRow[], now: Date): Promise<ShootingTask[]> {
  const people = await actorRefs(
    q,
    rows.flatMap((row) => [row.created_by, ...(row.handed_in_by ? [row.handed_in_by] : [])]),
  )
  const today = mskDate(now.toISOString())
  const actor = (id: string) =>
    people.get(id) ?? { type: 'system' as const, id: null, name: 'Система', gender: null }
  return rows.map((row) => {
    const late =
      row.handed_in_at === null && row.deadline_on !== null && row.deadline_on < today
        ? Math.round(
            (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.deadline_on}T00:00:00Z`)) /
              86_400_000,
          )
        : null
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      note: row.note,
      deadline: row.deadline_on,
      overdue_days: late !== null && late > 0 ? late : null,
      created_at: instant(row.created_at),
      created_by: actor(row.created_by),
      handed_in:
        row.handed_in_at && row.handed_in_by
          ? { at: instant(row.handed_in_at), by: actor(row.handed_in_by) }
          : null,
    }
  })
}

async function taskOf(q: Queryable, model: ModelScope, id: string): Promise<TaskRow> {
  const { rows } = await q.execute<TaskRow>(sql`
    SELECT ${COLUMNS} FROM shooting_tasks
     WHERE model_id = ${model.id}::uuid AND id = ${id}::uuid AND cancelled_at IS NULL`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такого ТЗ нет')
  return row
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function taskId(raw: string): string {
  if (!UUID.test(raw)) throw new ApiProblem('not_found', 'Такого ТЗ нет')
  return raw
}

export async function shootingTaskList(q: Queryable, model: ModelScope): Promise<ShootingTaskList> {
  const now = new Date()
  const { rows } = await q.execute<TaskRow>(sql`
    SELECT ${COLUMNS} FROM shooting_tasks
     WHERE model_id = ${model.id}::uuid AND cancelled_at IS NULL
       AND (handed_in_at IS NULL OR handed_in_at > now() - make_interval(days => ${DONE_DAYS}))
     ORDER BY handed_in_at DESC NULLS FIRST, deadline_on NULLS LAST, created_at`)
  const all = await views(q, rows, now)
  return { open: all.filter((task) => !task.handed_in), done: all.filter((task) => task.handed_in) }
}

export function shootingTaskHandlers({ db, command }: Services): HandlerRegistry {
  return {
    shootingTasks: {
      list: async ({ ctx }) => shootingTaskList(db, modelOf(ctx.model)),

      create: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const { rows } = await tx.execute<TaskRow>(sql`
            INSERT INTO shooting_tasks (model_id, title, kind, note, deadline_on, created_by)
            VALUES (${model.id}::uuid, ${body.title}, ${body.kind}, ${body.note?.trim() || null},
                    ${body.deadline ?? null}::date, ${actor.id}::uuid)
            RETURNING ${COLUMNS}`)
          const [task] = await views(tx, rows, new Date())
          return task!
        }),

      handIn: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await taskOf(tx, model, taskId(params.task))
          if (row.handed_in_at === null) {
            await tx.execute(sql`
              UPDATE shooting_tasks SET handed_in_at = now(), handed_in_by = ${actor.id}::uuid
               WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
          }
          const [task] = await views(tx, [await taskOf(tx, model, row.id)], new Date())
          return task!
        }),

      cancel: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const row = await taskOf(tx, model, taskId(params.task))
          await tx.execute(sql`
            UPDATE shooting_tasks SET cancelled_at = now(), cancelled_by = ${actor.id}::uuid
             WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
          const [task] = await views(tx, [row], new Date())
          return task!
        }),
    },
  }
}
