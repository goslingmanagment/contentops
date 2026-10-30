import type {
  CatalogEntry,
  CatalogIndex,
  PageSummaryIndex,
} from '@contentops/contracts/domain/catalog'
import type { PageSummaryEntry } from '@contentops/contracts/domain/placement'
import { hashString } from '@contentops/contracts/hash'
import { buildPageSummaries, type FactsContext } from '../fixtures/facts'
import type { ModelWorld } from '../fixtures/world-types'

/** The two index resources of a model (DESIGN §3.13, §10.2) and plain catalog lists. */

export function activeEntries(model: ModelWorld): CatalogEntry[] {
  return [...model.items.values()]
    .filter((record) => record.lifecycle.state === 'active')
    .map((record) => record.entry)
}

/** ETag from the content itself: any change of the data changes it, nothing else does. */
function contentTag(prefix: string, value: unknown): string {
  return `"${prefix}-${hashString(JSON.stringify(value)).toString(36)}"`
}

export function catalogIndex(context: FactsContext): CatalogIndex {
  const items = activeEntries(context.model)
  return {
    model: context.model.model.code,
    etag: contentTag('c', items),
    generated_at: context.now,
    items,
  }
}

export function pageSummaryIndex(context: FactsContext): PageSummaryIndex {
  const entries = buildPageSummaries(context).filter(
    (entry) => context.model.items.get(entry.item_id)?.lifecycle.state === 'active',
  )
  return {
    model: context.model.model.code,
    etag: contentTag('p', entries),
    generated_at: context.now,
    entries,
  }
}

export function summariesByPair(context: FactsContext): Map<string, PageSummaryEntry> {
  return new Map(
    buildPageSummaries(context).map((entry) => [`${entry.item_id}|${entry.account}`, entry]),
  )
}

export function pairKey(itemId: string, account: string): string {
  return `${itemId}|${account}`
}
