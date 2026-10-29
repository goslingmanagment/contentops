import { instantMs, mskDate } from '../clock'
import type { Instant, LocalDate } from '../domain/common'
import type { PlacementLevel } from '../domain/placement'

/** What each rule decides; the sign and the three facts are added by `evaluatePlacement`. */
export interface Outcome {
  level: PlacementLevel
  word: string
  detail: string | null
  reason: string
  date: LocalDate | null
}

export function dateOf(instant: Instant): LocalDate {
  return mskDate(instant)
}

export function hoursPassed(since: Instant, now: Instant, hours: number): boolean {
  return instantMs(now) - instantMs(since) >= hours * 3_600_000
}

export function laterOf(left: Instant, right: Instant): Instant {
  return instantMs(left) >= instantMs(right) ? left : right
}
