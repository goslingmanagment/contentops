import { createHash } from 'node:crypto'
import type { JournalQuerySchema } from '@contentops/contracts/api/routes/journal'
import type { JournalEvent } from '@contentops/contracts/domain/journal'
import { DEFAULT_PAGE_LIMIT } from '@contentops/contracts/domain/pagination'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { findItem, publicIdOf } from '../catalog/ids'
import { instant, requireActor } from '../commands'
import type { RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import {
  actorOf,
  areaOf,
  areaPatterns,
  describeEvent,
  type LogRow,
  SERVICE_ACTION_PATTERN,
} from '../journal/describe'
import { orderCondition } from '../orders/view'
import type { Services } from '../services'

/**
 * Журнал модели (DESIGN §4.18): only `action` rows, newest first, keyset pagination by
 * `(at, id)`. Events without a model (people, tokens, global switches and thresholds,
 * sign-ins) belong to no model's feed; the owner sees them in the journal of every model.
 *
 * What people and agents did is the default; the work queue's own rows (`work.*`, hundreds of
 * thousands a day) show only with «Кто: система». Without them the feed reads the partial
 * index `action_log_feed` instead of the whole journal.
 */

type JournalQuery = z.output<typeof JournalQuerySchema>

const CursorSchema = z.object({ at: z.string(), id: z.string().regex(/^\d+$/), f: z.string() })

const ACTOR_TYPE = { person: 'human', agent: 'agent', system: 'system' } as const

interface EventRow extends LogRow, Record<string, unknown> {
  id: string
  /** Text of `at` as Postgres gives it: keeps the microseconds for the cursor. */
  at_text: string
  actor_id: string | null
  request_id: string | null
  item_type: string | null
  item_number: number | null
}

/** The cursor belongs to the model and the filters it was given with (SPEC §11.2). */
function filterDigest(model: string, query: JournalQuery): string {
  const { cursor: _cursor, limit: _limit, ...filters } = query
  return createHash('sha256')
    .update(JSON.stringify([model, filters]))
    .digest('base64url')
    .slice(0, 12)
}

function readCursor(value: string | undefined, digest: string) {
  if (value === undefined) return null
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (parsed.f !== digest) throw new Error('cursor of another query')
    return parsed
  } catch {
    throw new ApiProblem('invalid_request', 'Курсор от другого запроса', { field: 'cursor' })
  }
}

function writeCursor(row: EventRow, digest: string): string {
  return Buffer.from(JSON.stringify({ at: row.at_text, id: row.id, f: digest })).toString(
    'base64url',
  )
}

function eventOf(row: EventRow): JournalEvent {
  const { phrase, changes } = describeEvent(row)
  const actor = actorOf(row)
  return {
    id: row.id,
    at: instant(row.at_text),
    actor: {
      type: row.actor_type === 'human' ? 'person' : row.actor_type,
      id: row.actor_id,
      name: actor.name,
      gender: actor.gender,
    },
    area: areaOf(row.action),
    action: row.action,
    phrase,
    item_id:
      row.item_type && row.item_number !== null ? publicIdOf(row.item_type, row.item_number) : null,
    thumb: null,
    result: row.result,
    changes,
    request_id: row.request_id ?? '',
  }
}

async function journalPage(services: Services, ctx: RequestContext, query: JournalQuery) {
  const actor = requireActor(ctx)
  const model = ctx.model
  if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
  const digest = filterDigest(model.code, query)
  const cursor = readCursor(query.cursor, digest)
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  const item = query.item
    ? await findItem(services.db, model, query.item, { withTombstones: true }).catch(() => null)
    : null
  if (query.item && !item) return { items: [], next_cursor: null }
  const order = query.order ? orderCondition(query.order) : null
  if (query.order && !order) return { items: [], next_cursor: null }
  const patterns = query.area ? areaPatterns(query.area) : null
  const actorType = query.actor_type ? ACTOR_TYPE[query.actor_type] : null
  // The queue's rows only for «Кто: система» without another «Что» (they are all «Система»).
  const service = actorType === 'system' && (!query.area || query.area === 'system')
  // Only the filters that are set: an `x IS NULL OR …` keeps the planner off the indexes.
  const filters = [
    sql`a.entry_kind = 'action'`,
    ...(service ? [] : [sql.raw(`a.action NOT LIKE '${SERVICE_ACTION_PATTERN}'`)]),
    ...(item ? [sql`a.item_id = ${item.id}::uuid`] : []),
    ...(order
      ? [
          sql`a.subject_kind = 'custom_orders' AND a.subject_id = (
            SELECT o.id FROM custom_orders o WHERE o.model_id = ${model.id}::uuid AND ${order})`,
        ]
      : []),
    ...(actorType ? [sql`a.actor_type = ${actorType}`] : []),
    ...(query.result ? [sql`a.result = ${query.result}`] : []),
    ...(query.from ? [sql`a.at >= ${query.from}::timestamptz`] : []),
    ...(query.to ? [sql`a.at <= ${query.to}::timestamptz`] : []),
    ...(patterns ? [sql`a.action LIKE ANY(${sql.param(patterns)}::text[])`] : []),
    ...(actor.role === 'reader' ? [sql`a.action NOT LIKE 'orders.%'`] : []),
    ...(cursor
      ? [
          sql`a.at <= ${cursor.at}::timestamptz`,
          sql`(a.at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::bigint)`,
        ]
      : []),
  ]
  const where = sql.join(filters, sql` AND `)
  // Two ordered branches instead of `model_id = … OR model_id IS NULL`: each walks its index
  // from the newest row and stops after a page.
  const ownerOnly = actor.role === 'owner' && !item && !order
  const { rows } = await services.db.execute<EventRow>(sql`
    WITH page AS (
      (SELECT a.* FROM action_log a
        WHERE a.model_id = ${model.id}::uuid AND ${where}
        ORDER BY a.at DESC, a.id DESC LIMIT ${limit + 1})
      ${
        ownerOnly
          ? sql`UNION ALL
      (SELECT a.* FROM action_log a
        WHERE a.model_id IS NULL AND ${where}
        ORDER BY a.at DESC, a.id DESC LIMIT ${limit + 1})`
          : sql``
      }
    )
    SELECT a.id::text AS id, a.at::text AS at_text, a.actor_type, a.actor_id, a.actor_label,
           p.gender, a.action, a.subject_label, a.before, a.after, a.result, a.request_id,
           i.type AS item_type, i.number AS item_number
      FROM page a LEFT JOIN principals p ON p.id = a.actor_id
      LEFT JOIN content_items i ON i.model_id = a.model_id AND i.id = a.item_id
     ORDER BY a.at DESC, a.id DESC
     LIMIT ${limit + 1}`)
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(eventOf),
    next_cursor: rows.length > limit && last ? writeCursor(last, digest) : null,
  }
}

export function journalHandlers(services: Services): HandlerRegistry {
  return {
    journal: {
      list: ({ query, ctx }) => journalPage(services, ctx, query),
    },
  }
}
