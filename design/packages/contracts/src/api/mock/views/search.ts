import type { CatalogEntry } from '../../../domain/catalog'
import { ITEM_TYPES } from '../../../domain/item-type'
import type { ResolveResult, SearchResult, TimelineHit } from '../../../domain/search'
import type { ModelWorld, World } from '../../../fixtures/world-types'
import { parseIdQuery, sectionOfQuery } from '../../../resolve'
import {
  compareSearchHits,
  entryHaystack,
  parseSearchQuery,
  passesSearchFilters,
  type SearchHaystack,
  type SearchQuery,
  searchRank,
  timelineMatches,
  titleMatches,
} from '../../../search-query'
import { activeEntries } from './catalog'

/** Server part of search: ID resolving, old numbers, words, timeline, drafts in «Приехало». */

export function resolveQuery(model: ModelWorld, query: string): ResolveResult {
  const id = parseIdQuery(query)
  const entries = activeEntries(model)
  const holders = id
    ? entries.filter((entry) => entry.aliases.includes(id)).map((entry) => entry.id)
    : []
  const exists = id !== null && model.items.get(id)?.lifecycle.state === 'active'
  return {
    query,
    item_id: exists ? id : null,
    parsed: id ? `${query.trim()} → ${id}` : null,
    old_number: id && holders.length > 1 ? { number: id, items: holders } : null,
    section: id ? null : sectionOfQuery(query),
  }
}

function haystackOf(world: World, model: ModelWorld, entry: CatalogEntry): SearchHaystack {
  const record = model.items.get(entry.id)
  const oldNames = record?.old_names.map((name) => name.name) ?? []
  return entryHaystack(entry, (key) => world.tags.find((tag) => tag.key === key)?.ru ?? key, [
    ...oldNames,
    record?.description ?? '',
  ])
}

function timelineHits(
  world: World,
  model: ModelWorld,
  query: SearchQuery,
  entries: readonly CatalogEntry[],
): TimelineHit[] {
  const hits: TimelineHit[] = []
  for (const entry of entries) {
    if (!passesSearchFilters(query, entry)) continue
    const timeline = model.items
      .get(entry.id)
      ?.markup?.find((field) => field.field.key === 'timeline')?.field
    if (timeline?.key !== 'timeline') continue
    const haystack = haystackOf(world, model, entry)
    for (const segment of timeline.value) {
      if (timelineMatches(query, segment.label, haystack)) {
        hits.push({ item_id: entry.id, t_s: segment.start_s, label: segment.label })
      }
    }
  }
  return hits
}

/**
 * The same reading of the query as the index in the browser (`parseSearchQuery`), plus
 * what only the server has: description, old names, timeline and drafts.
 */
export function searchModel(world: World, model: ModelWorld, query: string): SearchResult {
  const parsed = parseSearchQuery(query)
  const entries = activeEntries(model)
  const matches = entries
    .flatMap((entry) => {
      const rank = searchRank(parsed, entry, haystackOf(world, model, entry))
      return rank === null ? [] : [{ entry, rank }]
    })
    .sort(compareSearchHits)
    .map((hit) => hit.entry)
  return {
    resolve: resolveQuery(model, query),
    groups: ITEM_TYPES.flatMap((type) => {
      const ids = matches.filter((entry) => entry.type === type).map((entry) => entry.id)
      return ids.length > 0 ? [{ type, item_ids: ids.slice(0, 50), total: ids.length }] : []
    }),
    timeline: timelineHits(world, model, parsed, entries),
    inbox: model.inbox
      .filter((record) => titleMatches(parsed, record.group.title))
      .filter(
        (record) =>
          record.group.state.kind !== 'accepted' && record.group.state.kind !== 'rejected',
      )
      .map((record) => ({ group_id: record.group.id, title: record.group.title })),
  }
}
