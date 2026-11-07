/**
 * Protection of sign-in (SPEC §11.1): failed attempts are counted per login and per address.
 * Too many within the window close the key for a pause; each next closing doubles the pause,
 * up to the ceiling. A key quiet for a day is forgotten. The count lives in the memory of
 * `web`: a restart opens every key.
 */

const MINUTE = 60_000

export interface ThrottleRule {
  /** Failures within `windowMs` that close the key. */
  failures: number
  windowMs: number
  /** The first pause; every next closing doubles it, up to `maxPauseMs`. */
  pauseMs: number
  maxPauseMs: number
}

/** Per login, known or not: five wrong passwords in 15 min close it for 1, 2, 4 … 60 min. */
export const LOGIN_RULE: ThrottleRule = {
  failures: 5,
  windowMs: 15 * MINUTE,
  pauseMs: MINUTE,
  maxPauseMs: 60 * MINUTE,
}

/** Per address: twenty failures in 15 min close it for 5, 10, 20 … 60 min. */
export const ADDRESS_RULE: ThrottleRule = {
  failures: 20,
  windowMs: 15 * MINUTE,
  pauseMs: 5 * MINUTE,
  maxPauseMs: 60 * MINUTE,
}

const FORGET_MS = 24 * 60 * MINUTE
/** Above this many keys the oldest are dropped: logins sprayed at random cannot fill memory. */
const MAX_KEYS = 50_000

interface Entry {
  /** Times of the failures since the last closing, within the window. */
  failures: number[]
  closings: number
  closedUntil: number
  lastFailure: number
}

export class Throttle {
  private readonly entries = new Map<string, Entry>()
  private readonly rule: ThrottleRule
  private readonly now: () => number

  constructor(rule: ThrottleRule, now: () => number = Date.now) {
    this.rule = rule
    this.now = now
  }

  /** Milliseconds the key stays closed; 0 when it is open. */
  waitMs(key: string): number {
    const entry = this.entries.get(key)
    return entry ? Math.max(0, entry.closedUntil - this.now()) : 0
  }

  /** Counts a failure: the pause in milliseconds when it closes the key, otherwise 0. */
  fail(key: string): number {
    const now = this.now()
    const known = this.entries.get(key)
    const entry: Entry =
      known && now - known.lastFailure < FORGET_MS
        ? known
        : { failures: [], closings: 0, closedUntil: 0, lastFailure: now }
    entry.failures = entry.failures.filter((at) => now - at < this.rule.windowMs)
    entry.failures.push(now)
    entry.lastFailure = now
    let pause = 0
    if (entry.failures.length >= this.rule.failures) {
      pause = Math.min(this.rule.pauseMs * 2 ** entry.closings, this.rule.maxPauseMs)
      entry.closings += 1
      entry.closedUntil = now + pause
      entry.failures = []
    }
    // Re-inserted: the map keeps the most recent failures last, the oldest go first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= MAX_KEYS) break
      this.entries.delete(oldest)
    }
    return pause
  }

  /** A good password forgets the history of its key. */
  clear(key: string): void {
    this.entries.delete(key)
  }
}
