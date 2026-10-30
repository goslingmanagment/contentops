import { type Clock, instantFromMs, instantMs } from '@contentops/contracts/clock'
import type { Instant, LocalDate } from '@contentops/contracts/domain/common'

/**
 * «Сейчас» of the prototype: Tuesday 22.09.2026, 14:20 Moscow time. The fixtures and the
 * mock take the current moment from here.
 */
export const PROTOTYPE_NOW: Instant = '2026-09-22T11:20:00Z'
export const PROTOTYPE_TODAY: LocalDate = '2026-09-22'

/** A moving clock that starts at `start` and follows real time. */
export function createPrototypeClock(start: Instant = PROTOTYPE_NOW): Clock {
  const startedAt = Date.now()
  const startMs = instantMs(start)
  return { now: () => instantFromMs(startMs + (Date.now() - startedAt)) }
}
