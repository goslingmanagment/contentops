/**
 * Windows of the Hub poll (SPEC §8.1, PLAN 5). Pure functions: the times come from the
 * caller (the last successful poll is kept in Postgres), nothing here reads a clock.
 *
 * - hourly: `posts`, `post_attachments`, `raw_media`, `vault_media` of a page by
 *   `rowUpdatedAt` later than the last successful poll minus 3 h;
 * - once a day: minus a day (Hub's nightly vault walk moves `rowUpdatedAt` of the whole
 *   vault);
 * - a full re-read: the first poll, once a month, after a gap longer than a day, after a
 *   failure and after a Hub rebuild (the last two are the caller's to say).
 */

const HOUR = 60 * 60_000
const DAY = 24 * HOUR

export const HUB_POLL_INTERVAL_MS = HOUR
/** Statuses of ContentOps' own publications (SPEC §7). */
export const HUB_STATUS_POLL_INTERVAL_MS = 10 * 60_000
export const HOURLY_OVERLAP_MS = 3 * HOUR
export const DAILY_OVERLAP_MS = DAY
/** «раз в месяц»: 30 days. */
export const FULL_REREAD_EVERY_MS = 30 * DAY
/** A gap without a successful poll longer than this asks for a full re-read. */
export const MAX_GAP_MS = DAY
/** Overlap of the publications feed: rows may come again, the diff is idempotent. */
export const STATUS_OVERLAP_MS = 3 * HOUR

export interface PollState {
  /** The last successful poll of the page, of any mode. */
  lastSuccessAt: Date | null
  /** The last successful daily (or full) poll. */
  lastDailyAt: Date | null
  /** The last successful full re-read. */
  lastFullAt: Date | null
}

export type FullReason = 'first' | 'monthly' | 'gap' | 'failure' | 'rebuild'

export type PollPlan =
  | { mode: 'full'; reason: FullReason; updatedSince: null }
  | { mode: 'daily' | 'hourly'; updatedSince: Date }

export interface PlanPollInput extends PollState {
  now: Date
  /** The caller saw a failure that may have lost data, or Hub was rebuilt. */
  forceFull?: 'failure' | 'rebuild'
}

/** Which read this run of the page makes, and from when. */
export function planPoll(input: PlanPollInput): PollPlan {
  const now = input.now.getTime()
  const full = (reason: FullReason): PollPlan => ({ mode: 'full', reason, updatedSince: null })
  if (input.forceFull) return full(input.forceFull)
  if (input.lastSuccessAt === null || input.lastFullAt === null) return full('first')
  const last = input.lastSuccessAt.getTime()
  if (now - last > MAX_GAP_MS) return full('gap')
  if (now - input.lastFullAt.getTime() >= FULL_REREAD_EVERY_MS) return full('monthly')
  if (input.lastDailyAt === null || now - input.lastDailyAt.getTime() >= DAY) {
    return { mode: 'daily', updatedSince: new Date(last - DAILY_OVERLAP_MS) }
  }
  return { mode: 'hourly', updatedSince: new Date(last - HOURLY_OVERLAP_MS) }
}

/** The state after a successful run of `plan` that started at `startedAt`. */
export function afterPoll(state: PollState, plan: PollPlan, startedAt: Date): PollState {
  return {
    lastSuccessAt: startedAt,
    lastDailyAt: plan.mode === 'hourly' ? state.lastDailyAt : startedAt,
    lastFullAt: plan.mode === 'full' ? startedAt : state.lastFullAt,
  }
}

/**
 * `since` of the publications feed: the greatest `updatedAt` seen minus an overlap (Hub:
 * «keep the greatest updatedAt you saw and ask again from it minus an overlap»); null —
 * from the first one.
 */
export function publicationChangesSince(
  greatestUpdatedAt: Date | string | null,
  overlapMs = STATUS_OVERLAP_MS,
): Date | null {
  if (greatestUpdatedAt === null) return null
  const t = new Date(greatestUpdatedAt).getTime()
  if (Number.isNaN(t)) throw new TypeError(`not a time: ${String(greatestUpdatedAt)}`)
  return new Date(t - overlapMs)
}
