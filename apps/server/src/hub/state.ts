import type { Queryable, values } from '@contentops/db'
import { FULL_REREAD_EVERY_MS, HOURLY_OVERLAP_MS, type PollPlan, planPoll } from '@contentops/hub'
import { sql } from 'drizzle-orm'

/**
 * The poll boundary of a page and stream (`hub_sync_state`, schema §3.6, §9.6; SPEC §8.1):
 * which read a run makes — hourly by `rowUpdatedAt` minus 3 h, once a day minus a day, a full
 * re-read at the first run, a month after the last one, after a failed run, after a Hub
 * rebuild and after a gap longer than a day — and what a successful run leaves behind.
 */

export interface PageRef {
  modelId: string
  accountId: string
}

export interface SyncState {
  lastSuccessAt: Date | null
  lastDailyAt: Date | null
  nextFullAt: Date | null
  rebuiltAt: Date | null
}

const time = (value: string | Date | null | undefined): Date | null =>
  value === null || value === undefined ? null : new Date(value)

export async function readState(
  q: Queryable,
  page: PageRef,
  dataset: values.HubSyncDataset,
): Promise<SyncState> {
  const { rows } = await q.execute<{
    last_success_at: string | null
    last_daily_at: string | null
    next_full_at: string | null
    rebuilt_at: string | null
  }>(sql`
    SELECT last_success_at, last_daily_at, next_full_at, rebuilt_at FROM hub_sync_state
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND dataset = ${dataset} AND scope = 'page'`)
  const row = rows[0]
  return {
    lastSuccessAt: time(row?.last_success_at),
    lastDailyAt: time(row?.last_daily_at),
    nextFullAt: time(row?.next_full_at),
    rebuiltAt: time(row?.rebuilt_at),
  }
}

/** A run of this stream failed for good after the last success: the next read is full. */
export async function failedSinceSuccess(
  q: Queryable,
  page: PageRef,
  dataset: values.HubSyncDataset,
  lastSuccessAt: Date | null,
): Promise<boolean> {
  const { rows } = await q.execute(sql`
    SELECT 1 FROM work_operations
     WHERE kind = 'hub_sync' AND model_id = ${page.modelId}::uuid
       AND account_id = ${page.accountId}::uuid AND dataset = ${dataset} AND state = 'failed'
       AND finished_at > coalesce(${lastSuccessAt?.toISOString() ?? null}::timestamptz, '-infinity')
     LIMIT 1`)
  return rows.length > 0
}

/** The read of this run; `now` is the database clock at its start. */
export function planRun(state: SyncState, now: Date, failed: boolean): PollPlan {
  const lastFullAt = state.nextFullAt
    ? new Date(state.nextFullAt.getTime() - FULL_REREAD_EVERY_MS)
    : null
  const rebuilt = state.rebuiltAt !== null && (lastFullAt === null || state.rebuiltAt > lastFullAt)
  return planPoll({
    now,
    lastSuccessAt: state.lastSuccessAt,
    lastDailyAt: state.lastDailyAt,
    lastFullAt,
    ...(rebuilt
      ? { forceFull: 'rebuild' as const }
      : failed
        ? { forceFull: 'failure' as const }
        : {}),
  })
}

/** Coverage of the posts (entry E7): only from a Hub posts plan with proof (schema §9.6). */
export interface PostsCoverage {
  windowFrom: string | null
  windowTo: string | null
  expectedCount: number | null
  observedCount: number | null
  stopReason: string | null
  provenCompleteAt: string | null
}

export interface RunOutcome {
  /** Hub's own freshness of the stream, when it has one. */
  hubSucceededAt?: string | null
  consecutiveFailures?: number
  /** Hub stopped its own stream (`sync_streams.syncStatus`): the reason. */
  hubUnavailable?: string | null
  blockers: readonly string[]
  coverage?: PostsCoverage | null
}

/**
 * Moves the boundary after every page of the read is saved: inside the transaction that
 * finishes the work, so a run that lost its lease moves nothing.
 */
export async function saveSuccess(
  q: Queryable,
  page: PageRef,
  dataset: values.HubSyncDataset,
  input: { plan: PollPlan; startedAt: Date; workId: string; outcome: RunOutcome },
): Promise<void> {
  const { plan, startedAt, workId, outcome } = input
  const started = startedAt.toISOString()
  const watermark = new Date(startedAt.getTime() - HOURLY_OVERLAP_MS).toISOString()
  const daily = plan.mode === 'hourly' ? null : started
  const nextFull =
    plan.mode === 'full' ? new Date(startedAt.getTime() + FULL_REREAD_EVERY_MS).toISOString() : null
  const coverage = outcome.coverage ?? null
  await q.execute(sql`
    INSERT INTO hub_sync_state AS s (
      model_id, account_id, dataset, scope, watermark_at, last_success_at, last_daily_at,
      next_full_at, hub_succeeded_at, consecutive_failures, available, unavailable_reason,
      last_error, last_work_id, window_from, window_to, expected_count, observed_count,
      stop_reason, blockers, proven_complete_at
    ) VALUES (
      ${page.modelId}::uuid, ${page.accountId}::uuid, ${dataset}, 'page', ${watermark}::timestamptz,
      ${started}::timestamptz, ${daily}::timestamptz, ${nextFull}::timestamptz,
      ${outcome.hubSucceededAt ?? null}::timestamptz, ${outcome.consecutiveFailures ?? 0},
      ${!outcome.hubUnavailable}, ${outcome.hubUnavailable ?? null}, NULL, ${workId}::uuid,
      ${coverage?.windowFrom ?? null}::timestamptz, ${coverage?.windowTo ?? null}::timestamptz,
      ${coverage?.expectedCount ?? null}::integer, ${coverage?.observedCount ?? null}::integer,
      ${coverage?.stopReason ?? null}, ${sql.param([...outcome.blockers])}::text[],
      ${coverage?.provenCompleteAt ?? null}::timestamptz
    )
    ON CONFLICT (model_id, account_id, dataset, scope) DO UPDATE
       SET watermark_at = excluded.watermark_at,
           last_success_at = excluded.last_success_at,
           last_daily_at = coalesce(excluded.last_daily_at, s.last_daily_at),
           next_full_at = coalesce(excluded.next_full_at, s.next_full_at),
           hub_succeeded_at = coalesce(excluded.hub_succeeded_at, s.hub_succeeded_at),
           consecutive_failures = excluded.consecutive_failures,
           available = excluded.available,
           unavailable_reason = excluded.unavailable_reason,
           last_error = NULL,
           last_work_id = excluded.last_work_id,
           window_from = excluded.window_from,
           window_to = excluded.window_to,
           expected_count = excluded.expected_count,
           observed_count = excluded.observed_count,
           stop_reason = excluded.stop_reason,
           blockers = excluded.blockers,
           proven_complete_at = excluded.proven_complete_at,
           updated_at = now(),
           row_version = s.row_version + 1`)
}

/**
 * What a failed attempt leaves: its error, and — when Hub's answer itself is the reason (a
 * changed format, a refused key or page) — the stream is unavailable with that reason. The
 * boundary does not move.
 */
export async function saveFailure(
  q: Queryable,
  page: PageRef,
  dataset: values.HubSyncDataset,
  input: { workId: string; error: string; unavailable: string | null },
): Promise<void> {
  await q.execute(sql`
    INSERT INTO hub_sync_state AS s (
      model_id, account_id, dataset, scope, last_error, last_work_id, available,
      unavailable_reason
    ) VALUES (
      ${page.modelId}::uuid, ${page.accountId}::uuid, ${dataset}, 'page', ${input.error},
      ${input.workId}::uuid, ${input.unavailable === null}, ${input.unavailable}
    )
    ON CONFLICT (model_id, account_id, dataset, scope) DO UPDATE
       SET last_error = excluded.last_error,
           last_work_id = excluded.last_work_id,
           available = CASE WHEN excluded.unavailable_reason IS NULL THEN s.available ELSE false END,
           unavailable_reason = coalesce(excluded.unavailable_reason, s.unavailable_reason),
           updated_at = now(),
           row_version = s.row_version + 1`)
}

/** Hub refused a cursor as minted before its rebuild: a full re-read is due. */
export async function markRebuilt(
  q: Queryable,
  page: PageRef,
  dataset: values.HubSyncDataset,
  workId: string,
): Promise<void> {
  await q.execute(sql`
    INSERT INTO hub_sync_state AS s (model_id, account_id, dataset, scope, rebuilt_at, last_work_id)
    VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, ${dataset}, 'page', now(), ${workId}::uuid)
    ON CONFLICT (model_id, account_id, dataset, scope) DO UPDATE
       SET rebuilt_at = excluded.rebuilt_at, last_work_id = excluded.last_work_id,
           updated_at = now(), row_version = s.row_version + 1`)
}
