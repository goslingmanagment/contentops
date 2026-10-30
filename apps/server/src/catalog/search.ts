import { ITEM_TYPES, type ItemId, parseItemId } from '@contentops/contracts/domain/item-type'
import type { ResolveResult, SearchResult, TimelineHit } from '@contentops/contracts/domain/search'
import { parseIdQuery, sectionOfQuery } from '@contentops/contracts/resolve'
import {
  compareSearchHits,
  isBlankSearch,
  parseSearchQuery,
  passesSearchFilters,
  SEARCH_RANK,
  type SearchHaystack,
  type SearchRank,
  searchRank,
  searchTokens,
  timelineMatches,
  titleMatches,
} from '@contentops/contracts/search-query'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { catalogEntries } from './entries'
import { dbType, publicIdOf } from './ids'

/**
 * Search of a model (SPEC §11.2, §12.0 «Поиск»): the query is read by the same parser as the
 * browser's suggestions (`packages/contracts/search-query`): an ID in any form, type and
 * chatter words; the remaining words match by word start in titles, tags and old names, and
 * by full text (`catalog_search`: Russian and English titles, description, chronology,
 * aliases). A SHA-256 or its first 12+ hex digits finds the objects holding those bytes.
 */

const SHA_PREFIX = /^[0-9a-f]{12,64}$/i
const GROUP_LIMIT = 50

/** Objects whose old number (legacy or merged ID) is this ID. */
async function oldNumberHolders(
  q: Queryable,
  model: ModelScope,
  id: ItemId,
): Promise<{ uid: string; id: ItemId }[]> {
  const { rows } = await q.execute<{ uid: string; type: string; number: number }>(sql`
    SELECT DISTINCT i.id AS uid, i.type, i.number
      FROM aliases a
      JOIN content_items i ON i.model_id = a.model_id AND i.id = a.item_id
     WHERE a.model_id = ${model.id}::uuid AND a.kind IN ('legacy_id', 'merged_id')
       AND a.value_norm = lower(normalize(${id}, NFC)) AND i.deleted_at IS NULL
     ORDER BY i.type, i.number`)
  return rows.map((row) => ({ uid: row.uid, id: publicIdOf(row.type, row.number) }))
}

/** `resolve(model, "ппв 73")`: the current object and the objects that had this old number. */
export async function resolveQuery(
  q: Queryable,
  model: ModelScope,
  query: string,
): Promise<ResolveResult> {
  const id = parseIdQuery(query)
  if (!id)
    return { query, item_id: null, parsed: null, old_number: null, section: sectionOfQuery(query) }
  const parsed = parseItemId(id)
  const live = parsed
    ? await q.execute<{ uid: string }>(sql`
        SELECT id AS uid FROM content_items
         WHERE model_id = ${model.id}::uuid AND type = ${dbType(parsed.type)}
           AND number = ${parsed.number} AND deleted_at IS NULL`)
    : { rows: [] }
  const exists = live.rows.length > 0
  const holders = (await oldNumberHolders(q, model, id)).filter((holder) => holder.id !== id)
  const single = !exists && holders.length === 1 ? holders[0] : undefined
  return {
    query,
    item_id: exists ? id : (single?.id ?? null),
    parsed: `${query.trim()} → ${id}`,
    old_number:
      holders.length > 0 && !single
        ? { number: id, items: holders.map((holder) => holder.id) }
        : null,
    section: null,
  }
}

interface ExtraRow extends Record<string, unknown> {
  item_id: string
  words: string | null
}

interface SegmentRow extends Record<string, unknown> {
  item_id: string
  at_ms: number
  text: string
}

export async function searchCatalog(
  q: Queryable,
  model: ModelScope,
  query: string,
): Promise<SearchResult> {
  const resolve = await resolveQuery(q, model, query)
  const parsed = parseSearchQuery(query)
  const entries = await catalogEntries(q, model)
  const byUid = new Map(entries.map((entry) => [entry.uid, entry]))
  const hits = new Map<string, SearchRank>()
  const timeline: TimelineHit[] = []

  if (parsed.id) {
    const holders = new Set(resolve.old_number?.items ?? [])
    if (resolve.item_id) holders.add(resolve.item_id)
    for (const entry of entries) {
      if (entry.id === parsed.id || holders.has(entry.id)) hits.set(entry.uid, SEARCH_RANK.id)
    }
  } else if (SHA_PREFIX.test(query.trim())) {
    const { rows } = await q.execute<{ item_id: string }>(sql`
      SELECT DISTINCT im.item_id
        FROM asset_versions v
        JOIN item_memberships im ON im.model_id = v.model_id AND im.asset_id = v.asset_id
       WHERE v.model_id = ${model.id}::uuid
         AND encode(v.master_sha256, 'hex') LIKE ${`${query.trim().toLowerCase()}%`}`)
    for (const row of rows) if (byUid.has(row.item_id)) hits.set(row.item_id, SEARCH_RANK.id)
  } else if (!isBlankSearch(parsed)) {
    const [tags, extras, segments, fullText] = await Promise.all([
      q.execute<{ slug: string; label: string }>(sql`
        SELECT slug, label_ru AS label FROM tags
         WHERE model_id IS NULL OR model_id = ${model.id}::uuid`),
      q.execute<ExtraRow>(sql`
        SELECT i.id AS item_id,
               concat_ws(' ', i.description, string_agg(a.value_raw, ' ')) AS words
          FROM content_items i
          LEFT JOIN aliases a ON a.model_id = i.model_id AND a.item_id = i.id
         WHERE i.model_id = ${model.id}::uuid AND i.deleted_at IS NULL
         GROUP BY i.model_id, i.id`),
      q.execute<SegmentRow>(sql`
        SELECT c.item_id, c.at_ms::float8 AS at_ms, c.text
          FROM chronology_entries c
          JOIN item_memberships im ON im.model_id = c.model_id AND im.item_id = c.item_id
                                  AND im.kind = 'owned' AND im.role = 'master'
                                  AND im.variant_no = 0 AND im.removed_at IS NULL
          JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
                       AND a.current_version_id = c.asset_version_id
         WHERE c.model_id = ${model.id}::uuid
         ORDER BY c.item_id, c.at_ms`),
      parsed.stems.length > 0
        ? q.execute<{ item_id: string }>(sql`
            SELECT item_id FROM catalog_search(${model.id}::uuid, ${parsed.stems.join(' ')})`)
        : Promise.resolve({ rows: [] }),
    ])
    const labels = new Map(tags.rows.map((tag) => [tag.slug, tag.label]))
    const extraOf = new Map(extras.rows.map((row) => [row.item_id, row.words ?? '']))
    const segmentsOf = new Map<string, SegmentRow[]>()
    for (const row of segments.rows) {
      const list = segmentsOf.get(row.item_id) ?? []
      list.push(row)
      segmentsOf.set(row.item_id, list)
    }
    const found = new Set(fullText.rows.map((row) => row.item_id))
    for (const entry of entries) {
      const own = segmentsOf.get(entry.uid) ?? []
      const haystack: SearchHaystack = {
        title: searchTokens(entry.id, entry.title, entry.title_en ?? '', ...entry.aliases),
        tags: searchTokens(...entry.tags.map((slug) => `${labels.get(slug) ?? ''} ${slug}`)),
        extra: searchTokens(extraOf.get(entry.uid) ?? '', ...own.map((row) => row.text)),
      }
      const rank =
        searchRank(parsed, entry, haystack) ??
        (found.has(entry.uid) && passesSearchFilters(parsed, entry) ? SEARCH_RANK.extra : null)
      if (rank !== null) hits.set(entry.uid, rank)
      if (!passesSearchFilters(parsed, entry)) continue
      for (const row of own) {
        if (timelineMatches(parsed, row.text, haystack)) {
          timeline.push({ item_id: entry.id, t_s: Math.round(row.at_ms / 1000), label: row.text })
        }
      }
    }
  }

  const ordered = [...hits]
    .flatMap(([uid, rank]) => {
      const entry = byUid.get(uid)
      return entry ? [{ rank, entry }] : []
    })
    .sort(compareSearchHits)
    .map((hit) => hit.entry)
  return {
    resolve,
    groups: ITEM_TYPES.flatMap((type) => {
      const ids = ordered.filter((entry) => entry.type === type).map((entry) => entry.id)
      return ids.length > 0
        ? [{ type, item_ids: ids.slice(0, GROUP_LIMIT), total: ids.length }]
        : []
    }),
    timeline,
    inbox: await inboxHits(q, model, query),
  }
}

/** Drafts in «Приехало» are found by their proposed title at once (PRD §5). */
async function inboxHits(q: Queryable, model: ModelScope, query: string) {
  const parsed = parseSearchQuery(query)
  if (parsed.id || parsed.stems.length === 0) return []
  const { rows } = await q.execute<{ id: string; title: string }>(sql`
    SELECT id, proposed_title AS title FROM inbox_groups
     WHERE model_id = ${model.id}::uuid AND closed_at IS NULL AND proposed_title IS NOT NULL
     ORDER BY discovered_at DESC`)
  return rows
    .filter((row) => titleMatches(parsed, row.title))
    .map((row) => ({ group_id: row.id, title: row.title }))
}
