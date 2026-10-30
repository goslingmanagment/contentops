import type { ItemsQuerySchema } from '@contentops/contracts/api/routes/objects'
import type { CatalogEntry, RecentItem } from '@contentops/contracts/domain/catalog'
import type { MarkupReviewItem } from '@contentops/contracts/domain/markup-review'
import { DEFAULT_PAGE_LIMIT } from '@contentops/contracts/domain/pagination'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import { itemDetail } from '../catalog/detail'
import { catalogEntries, contentTag } from '../catalog/entries'
import { dbType, modelOf, publicIdOf } from '../catalog/ids'
import { markupFields } from '../catalog/markup'
import { filterDigest, pageOf, readCursor } from '../catalog/paging'
import { resolveQuery, searchCatalog } from '../catalog/search'
import { instant, requireActor } from '../commands'
import { type ModelScope, withContentTag } from '../context'
import type { HandlerRegistry } from '../handlers'
import { reasonOf } from '../journal/describe'
import type { Services } from '../services'

/**
 * Reading the catalog of a model (DESIGN §4.1–4.7, SPEC §12.0 «Интерфейс»): the two index
 * resources whole with a content ETag, lists with keyset pages, resolve and search, the
 * object page and «Разметка на проверку». Placements come with stages 3–5: the page summary
 * is empty («не видели» everywhere) and «где залито: да» finds nothing.
 */

type ItemsQuery = z.output<typeof ItemsQuerySchema>

/** The entry without the server's own keys, as the contract has it. */
function plain({
  uid: _uid,
  created_at: _at,
  ...entry
}: CatalogEntry & { uid: string; created_at: string }): CatalogEntry {
  return entry
}

async function catalogIndex(db: Queryable, model: ModelScope) {
  const items = (await catalogEntries(db, model)).map(plain)
  return { items, etag: contentTag('c', items) }
}

async function listItems(db: Queryable, model: ModelScope, query: ItemsQuery) {
  const digest = filterDigest(model.code, { ...query, cursor: undefined, limit: undefined })
  const cursor = readCursor(query.cursor, digest)
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  // Nothing is placed before the placements of stage 3: «залито на странице» finds nothing.
  const placed = (query.where ?? []).some((condition) => condition.endsWith(':yes'))
  if (placed) return { items: [], next_cursor: null }
  const rows = await catalogEntries(
    db,
    model,
    sql`
      ${query.type ? sql`AND c.type = ${dbType(query.type)}` : sql``}
      ${query.kind ? sql`AND c.ppv_kind = ${query.kind}` : sql``}
      ${query.tag?.length ? sql`AND c.tags @> ${sql.param(query.tag)}::text[]` : sql``}
      ${cursor ? sql`AND (c.created_at, c.item_id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)` : sql``}`,
    sql`ORDER BY c.created_at DESC, c.item_id DESC LIMIT ${limit + 1}`,
  )
  return pageOf(rows, limit, plain, (row) => [row.created_at, row.uid], digest)
}

const RECENT_LIMIT = 20

async function recentItems(db: Queryable, model: ModelScope, actorId: string) {
  const { rows } = await db.execute<{
    type: string
    number: number
    action: string
    at: string
  }>(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (a.item_id) i.type, i.number, a.action, a.at::text AS at
        FROM action_log a
        JOIN content_items i ON i.model_id = a.model_id AND i.id = a.item_id
       WHERE a.model_id = ${model.id}::uuid AND a.entry_kind = 'action' AND a.result = 'ok'
         AND a.actor_id = ${actorId}::uuid AND i.deleted_at IS NULL
       ORDER BY a.item_id, a.at DESC
    ) last ORDER BY at DESC LIMIT ${RECENT_LIMIT}`)
  const items: RecentItem[] = rows.map((row) => ({
    item_id: publicIdOf(row.type, row.number),
    reason: reasonOf(row.action),
    at: instant(row.at),
  }))
  return { items, next_cursor: null }
}

interface DeletedRow extends Record<string, unknown> {
  id: string
  type: string
  number: number
  title: string | null
  deleted_at: string
  deleted_by: string | null
  into_type: string | null
  into_number: number | null
}

async function deletedItems(
  db: Queryable,
  model: ModelScope,
  query: { cursor?: string; limit?: number },
) {
  const digest = filterDigest(model.code, 'deleted')
  const cursor = readCursor(query.cursor, digest)
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT
  const { rows } = await db.execute<DeletedRow>(sql`
    SELECT i.id, i.type, i.number, i.title, i.deleted_at::text AS deleted_at,
           p.display_name AS deleted_by, m.type AS into_type, m.number AS into_number
      FROM content_items i
      LEFT JOIN principals p ON p.id = i.deleted_by
      LEFT JOIN content_items m ON m.model_id = i.model_id AND m.id = i.merged_into_item_id
     WHERE i.model_id = ${model.id}::uuid AND i.deleted_at IS NOT NULL
       ${cursor ? sql`AND (i.deleted_at, i.id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)` : sql``}
     ORDER BY i.deleted_at DESC, i.id DESC LIMIT ${limit + 1}`)
  return pageOf(
    rows,
    limit,
    (row) => ({
      item_id: publicIdOf(row.type, row.number),
      title: row.title ?? '',
      deleted_at: instant(row.deleted_at),
      deleted_by: row.into_type ? 'слияние' : (row.deleted_by ?? 'Система'),
      merged_into:
        row.into_type && row.into_number !== null
          ? publicIdOf(row.into_type, row.into_number)
          : null,
    }),
    (row) => [row.deleted_at, row.id],
    digest,
  )
}

/** Objects with a field still in draft, newest first: the whole list, like the index. */
async function markupReview(db: Queryable, model: ModelScope) {
  const { rows } = await db.execute<{
    id: string
    type: 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW' | 'PRM'
    number: number
    title: string | null
    title_en: string | null
    description: string | null
  }>(sql`
    SELECT id, type, number, title, title_en, description FROM content_items
     WHERE model_id = ${model.id}::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`)
  const fields = await markupFields(
    db,
    model,
    rows.map((row) => ({ uid: row.id, ...row })),
  )
  const items: MarkupReviewItem[] = rows.flatMap((row) => {
    const own = fields.get(row.id) ?? []
    const draft = own.some((field) => field.status !== 'confirmed' && field.status !== 'empty')
    return draft ? [{ item_id: publicIdOf(row.type, row.number), fields: own }] : []
  })
  return { items, next_cursor: null }
}

export function catalogHandlers({ db }: Services): HandlerRegistry {
  return {
    objects: {
      catalogIndex: async ({ ctx }) => {
        const model = modelOf(ctx.model)
        const { items, etag } = await catalogIndex(db, model)
        return withContentTag(ctx, etag, {
          model: model.code,
          etag,
          generated_at: new Date().toISOString(),
          items,
        })
      },
      pageSummaries: ({ ctx }) => {
        const model = modelOf(ctx.model)
        const etag = contentTag('p', [])
        return withContentTag(ctx, etag, {
          model: model.code,
          etag,
          generated_at: new Date().toISOString(),
          entries: [],
        })
      },
      list: ({ query, ctx }) => listItems(db, modelOf(ctx.model), query),
      recent: ({ ctx }) => recentItems(db, modelOf(ctx.model), requireActor(ctx).id),
      deleted: ({ ctx }) => deletedItems(db, modelOf(ctx.model), {}),
      resolve: ({ query, ctx }) => resolveQuery(db, modelOf(ctx.model), query.q),
      search: ({ query, ctx }) => searchCatalog(db, modelOf(ctx.model), query.q),
      get: ({ params, ctx }) => itemDetail(db, modelOf(ctx.model), params.id),
    },
    markup: {
      review: ({ ctx }) => markupReview(db, modelOf(ctx.model)),
    },
  }
}
