import type { CatalogEntry } from './domain/catalog'
import type { ItemType } from './domain/item-type'
import type { Platform } from './domain/model'
import type { PageSummaryEntry } from './domain/placement'

export type NotUploadedStatus = 'not_applicable' | 'placed' | 'in_plan' | 'not_uploaded'

/** Order of groups in «Ещё не залито»; FYP last and folded (DESIGN §4.3). */
export const NOT_UPLOADED_TYPES: readonly ItemType[] = ['ppv', 'sexting', 'life', 'set', 'fyp']

function applies(entry: CatalogEntry, platform: Platform): boolean {
  if (entry.second_person && platform === 'onlyfans') return false
  switch (entry.type) {
    case 'ppv':
    case 'sexting':
    case 'set':
      return true
    case 'life':
      return platform === 'fansly' && (entry.life_chat_count ?? 0) > 0
    case 'fyp':
      return platform === 'fansly'
    default:
      return false
  }
}

function isPlaced(entry: CatalogEntry, summary: PageSummaryEntry | undefined): boolean {
  if (!summary) return false
  if (entry.type === 'set' || entry.type === 'fyp') return summary.placed_on.length > 0
  return summary.placed_on.includes('vault')
}

/**
 * Whether an object belongs to «Ещё не залито» of a page (DESIGN §4.3, §10.3):
 * PPV, sextings and life («в чаты» and «оба») without a vault placement of any level;
 * sets and FYP never seen on the page. Second person in frame never goes to OnlyFans.
 * What is already in the plan for this page is hidden and counted apart.
 */
export function notUploadedStatus(
  entry: CatalogEntry,
  summary: PageSummaryEntry | undefined,
  platform: Platform,
): NotUploadedStatus {
  if (!applies(entry, platform)) return 'not_applicable'
  if (isPlaced(entry, summary)) return 'placed'
  if (summary && summary.planned_on.length > 0) return 'in_plan'
  return 'not_uploaded'
}
