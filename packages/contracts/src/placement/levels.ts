import type { Sign } from '../domain/common'
import type { PlacementLevel } from '../domain/placement'

/** The sign of every level (DESIGN §5.1): ✓ done, ◆ your turn, ▲ trouble, or a grey word. */
const SIGN_BY_LEVEL: Record<PlacementLevel, Sign | null> = {
  planned: null,
  missed: 'trouble',
  marked_manual: 'done',
  marked: null,
  scheduled: null,
  confirmed_exact: 'done',
  confirmed_hub_unmarked: 'done',
  confirmed_manual: 'done',
  confirmed_earlier: 'done',
  confirmed_reupload: 'done',
  candidate: 'turn',
  candidates_multiple: 'turn',
  partial_match: 'turn',
  mismatch: 'turn',
  conflict: 'turn',
  surface_unknown: 'turn',
  unplanned_post: 'turn',
  vault_missing: 'turn',
  vault_stale: 'turn',
  cannot_verify: null,
  unknown: null,
  not_found_in_walk: null,
  not_published: 'trouble',
  history_candidate: null,
  blocked_second_person: 'trouble',
  cancelled: null,
  outside_catalog: null,
}

export function signOfLevel(level: PlacementLevel): Sign | null {
  return SIGN_BY_LEVEL[level]
}

/** Levels that count as «размещение любого уровня»: exact, candidate or a КМ mark. */
const PLACED_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'marked_manual',
  'marked',
  'confirmed_exact',
  'confirmed_hub_unmarked',
  'confirmed_manual',
  'confirmed_earlier',
  'confirmed_reupload',
  'candidate',
  'candidates_multiple',
  'partial_match',
  'mismatch',
  'conflict',
  'surface_unknown',
  'vault_missing',
  'vault_stale',
  'cannot_verify',
  'history_candidate',
])

export function isPlacedLevel(level: PlacementLevel): boolean {
  return PLACED_LEVELS.has(level)
}

/** Levels of a row that is still waiting in the plan (not placed yet). */
const IN_PLAN_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'planned',
  'scheduled',
  'missed',
  'blocked_second_person',
])

export function isInPlanLevel(level: PlacementLevel): boolean {
  return IN_PLAN_LEVELS.has(level)
}
