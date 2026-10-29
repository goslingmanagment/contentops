import type { AccountCode } from './domain/common'
import type { ItemId } from './domain/item-type'
import type {
  PageSummaryEntry,
  PlacementLevel,
  PlacementVerdict,
  SurfaceKind,
} from './domain/placement'
import { isInPlanLevel, isPlacedLevel, signOfLevel } from './placement'

/** One surface of a page and what the placement function said about it. */
export interface SurfaceVerdict {
  surface: SurfaceKind
  verdict: PlacementVerdict
}

export interface PageStats {
  views: number
  likes: number
  on: string
}

/**
 * The strongest of what is seen on all surfaces of a page (DESIGN §4.4):
 * ✓ and date, «отмечено» and date, ◆ «сверить», ▲, «не видели».
 */
function strength(level: PlacementLevel): number {
  if (level === 'cancelled' || level === 'outside_catalog') return -1
  const sign = signOfLevel(level)
  if (sign === 'done') return 70
  if (level === 'marked') return 60
  if (level === 'scheduled') return 50
  if (sign === 'turn') return 40
  if (sign === 'trouble') return 30
  if (level === 'planned') return 20
  if (level === 'cannot_verify' || level === 'not_found_in_walk') return 10
  return 0
}

function latestDate(dates: readonly (string | null)[]): string | null {
  return dates.reduce<string | null>(
    (latest, date) => (date && (!latest || date > latest) ? date : latest),
    null,
  )
}

const UNSEEN: Pick<PageSummaryEntry, 'level' | 'sign' | 'word' | 'detail'> = {
  level: 'unknown',
  sign: null,
  word: 'не видели',
  detail: null,
}

/** Folds the verdicts of one «объект × страница» pair into a page summary entry. */
export function summarizePage(
  itemId: ItemId,
  account: AccountCode,
  surfaces: readonly SurfaceVerdict[],
  options: { hasFypVersion?: boolean; stats?: PageStats | null } = {},
): PageSummaryEntry {
  const visible = surfaces.filter((entry) => strength(entry.verdict.level) >= 0)
  const strongest = visible.reduce<SurfaceVerdict | null>((best, entry) => {
    if (!best) return entry
    const difference = strength(entry.verdict.level) - strength(best.verdict.level)
    if (difference !== 0) return difference > 0 ? entry : best
    return (entry.verdict.date ?? '') > (best.verdict.date ?? '') ? entry : best
  }, null)
  const head = strongest
    ? {
        level: strongest.verdict.level,
        sign: strongest.verdict.sign,
        word: strongest.verdict.word,
        detail: strongest.verdict.detail,
      }
    : UNSEEN
  const placed = visible.filter((entry) => isPlacedLevel(entry.verdict.level))
  const stats = options.stats ?? null
  return {
    item_id: itemId,
    account,
    ...head,
    last_on: latestDate(placed.map((entry) => entry.verdict.date)),
    has_turn: visible.some((entry) => entry.verdict.sign === 'turn'),
    has_trouble: visible.some((entry) => entry.verdict.sign === 'trouble'),
    placed_on: unique(placed.map((entry) => entry.surface)),
    planned_on: unique(
      visible.filter((entry) => isInPlanLevel(entry.verdict.level)).map((entry) => entry.surface),
    ),
    has_fyp_version: options.hasFypVersion ?? false,
    views: stats?.views ?? null,
    likes: stats?.likes ?? null,
    stats_on: stats?.on ?? null,
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
