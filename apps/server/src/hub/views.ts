import type { IntegrationDownReason } from '@contentops/contracts/domain/integrations'
import type { SystemState } from '@contentops/contracts/domain/system'
import { formatNumber } from '@contentops/contracts/format'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { HUB_ERROR_CODES } from './sync'

/**
 * What the screens read about Hub (SPEC §7, §8; DESIGN §3.11, §4.19): the state of the poll of
 * each page for «Интеграции» and the plan's Hub lines, and the delay monitor of «Состояние».
 */

/** Older than the «не вышло» window (24 h): «Hub не обновлял посты с …» (SPEC §7). */
export const HUB_STALE_MS = 24 * 60 * 60_000
/** The «ждём Hub» window at the launch of stage 5 when no threshold is set (SPEC §7). */
const DEFAULT_WAIT_HOURS = 8

/** The poll of one page as the integration line tells it, for a configured page that is on. */
export interface HubPageState {
  state: 'working' | 'down'
  downReason: IntegrationDownReason | null
  since: string | null
  retryAt: string | null
  /** Hub's own freshness of the posts: «Hub · посты на 18:32». */
  postsAt: string | null
  /** Hub's latest full walk of a vault album of the page. */
  vaultWalkAt: string | null
  /** The last successful poll of ContentOps, any stream of the page. */
  polledAt: string | null
}

interface WorkFact extends Record<string, unknown> {
  account_id: string
  dataset: string
  state: string
  error_code: string | null
  finished_at: string | null
  started_at: string | null
  next_attempt_at: string
  paused_reason: string | null
}

const iso = (value: string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null

/** States of the Hub poll of the given pages (all pages when `accountIds` is omitted). */
export async function hubPageStates(
  q: Queryable,
  now: Date,
  accountIds?: readonly string[],
): Promise<Map<string, HubPageState>> {
  const only = accountIds
    ? sql`AND account_id = ANY (${sql.param([...accountIds])}::uuid[])`
    : sql``
  const { rows: states } = await q.execute<{
    account_id: string
    dataset: string
    hub_succeeded_at: string | null
    last_success_at: string | null
  }>(sql`
    SELECT account_id, dataset, hub_succeeded_at, last_success_at FROM hub_sync_state
     WHERE scope = 'page' ${only}`)
  // The last finished run of each stream, and every unfinished one.
  const { rows: works } = await q.execute<WorkFact>(sql`
    (SELECT DISTINCT ON (account_id, dataset) account_id, dataset, state, error_code,
            finished_at::text, started_at::text, next_attempt_at::text, paused_reason
       FROM work_operations
      WHERE kind = 'hub_sync' AND state IN ('succeeded', 'failed') ${only}
      ORDER BY account_id, dataset, finished_at DESC)
    UNION ALL
    (SELECT account_id, dataset, state, error_code, finished_at::text, started_at::text,
            next_attempt_at::text, paused_reason
       FROM work_operations
      WHERE kind = 'hub_sync' AND state IN ('pending', 'running', 'retry_wait') ${only})`)
  // A refused key is refused for every page: since its first refusal after the last success.
  const { rows: refused } = await q.execute<{ since: string | null }>(sql`
    SELECT min(finished_at)::text AS since FROM work_operations
     WHERE kind = 'hub_sync' AND state = 'failed' AND error_code = ${HUB_ERROR_CODES.authRejected}
       AND finished_at > coalesce(
         (SELECT max(finished_at) FROM work_operations WHERE kind = 'hub_sync' AND state = 'succeeded'),
         '-infinity')`)
  const keyRefusedSince = iso(refused[0]?.since)

  const accounts = new Set([
    ...states.map((row) => row.account_id),
    ...works.map((row) => row.account_id),
    ...(accountIds ?? []),
  ])
  const out = new Map<string, HubPageState>()
  for (const accountId of accounts) {
    const own = states.filter((row) => row.account_id === accountId)
    const posts = own.find((row) => row.dataset === 'posts')
    const vault = own.find((row) => row.dataset === 'vault_media')
    const runs = works.filter((row) => row.account_id === accountId)
    const polled = own
      .map((row) => row.last_success_at)
      .filter((at): at is string => at !== null)
      .sort()
      .at(-1)
    const base: HubPageState = {
      state: 'working',
      downReason: null,
      since: null,
      retryAt: null,
      postsAt: iso(posts?.hub_succeeded_at),
      vaultWalkAt: iso(vault?.hub_succeeded_at),
      polledAt: iso(polled),
    }
    out.set(accountId, { ...base, ...downOf(runs, base, keyRefusedSince, now) })
  }
  return out
}

function downOf(
  runs: readonly WorkFact[],
  base: HubPageState,
  keyRefusedSince: string | null,
  now: Date,
): Partial<HubPageState> {
  if (keyRefusedSince) {
    return { state: 'down', downReason: 'token_rejected', since: keyRefusedSince }
  }
  // A failure counts while no stream of the page has succeeded after it.
  const lastOk = runs
    .filter((row) => row.state === 'succeeded' && row.finished_at !== null)
    .map((row) => Date.parse(row.finished_at as string))
    .reduce((latest, at) => Math.max(latest, at), Number.NEGATIVE_INFINITY)
  const finished = runs.filter(
    (row) => row.finished_at !== null && Date.parse(row.finished_at) > lastOk,
  )
  const failedWith = (codes: readonly string[]) =>
    finished
      .filter((row) => row.state === 'failed' && codes.includes(row.error_code ?? ''))
      .map((row) => row.finished_at as string)
      .sort()
  const notGranted = failedWith([HUB_ERROR_CODES.pageNotGranted])
  if (notGranted.length > 0) {
    return { state: 'down', downReason: 'token_rejected', since: iso(notGranted[0]) }
  }
  const format = failedWith([HUB_ERROR_CODES.formatChanged])
  if (format.length > 0)
    return { state: 'down', downReason: 'format_changed', since: iso(format[0]) }
  // An outage: a run waits for its retry, or the last run of a stream failed.
  const retrying = runs
    .filter((row) => row.state === 'retry_wait' && row.paused_reason === null && row.error_code)
    .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
  const failed = failedWith([
    HUB_ERROR_CODES.unavailable,
    HUB_ERROR_CODES.rateLimited,
    HUB_ERROR_CODES.refused,
    HUB_ERROR_CODES.rebuilt,
    'attempts_exhausted',
    'unexpected',
  ])
  if (retrying.length > 0 || failed.length > 0) {
    const starts = [
      ...retrying.map((row) => row.started_at).filter((at): at is string => at !== null),
      ...failed,
    ].sort()
    return {
      state: 'down',
      downReason: 'unreachable',
      since: iso(starts[0]),
      retryAt: iso(retrying[0]?.next_attempt_at),
    }
  }
  // Hub answers, but its own posts are older than a day.
  if (base.postsAt && now.getTime() - Date.parse(base.postsAt) > HUB_STALE_MS) {
    return { state: 'down', downReason: 'stale', since: base.postsAt }
  }
  return {}
}

const round = (hours: number) => Math.round(hours * 10) / 10

/**
 * The delay monitor (SPEC §7): how long Hub takes to see a post — from `publishedAt` to Hub's
 * first sighting — over 30 days, per page; warns when p90 is longer than the «ждём» window
 * or the maximum longer than the «не вышло» window. `null` until Hub saw a post.
 */
export async function hubLatency(q: Queryable): Promise<SystemState['hub_latency']> {
  const { rows } = await q.execute<{
    label: string
    median_s: number | null
    p90_s: number | null
    max_s: number | null
    n: number
  }>(sql`
    SELECT a.title || ' ' || m.title AS label,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY d.s) AS median_s,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY d.s) AS p90_s,
           max(d.s) AS max_s, count(*)::int AS n
      FROM hub_posts p
      JOIN accounts a ON a.model_id = p.model_id AND a.id = p.account_id
      JOIN models m ON m.id = a.model_id
     CROSS JOIN LATERAL (SELECT extract(epoch FROM p.first_observed_at - p.published_at)::float8 AS s) d
     WHERE p.published_at > now() - interval '30 days' AND d.s >= 0
     GROUP BY a.model_id, a.id, a.title, m.title`)
  if (rows.length === 0) return null
  const { rows: all } = await q.execute<{ median_s: number | null; max_s: number | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.s) AS median_s, max(d.s) AS max_s
      FROM hub_posts p
     CROSS JOIN LATERAL (SELECT extract(epoch FROM p.first_observed_at - p.published_at)::float8 AS s) d
     WHERE p.published_at > now() - interval '30 days' AND d.s >= 0`)
  const windows = await thresholds(q)
  const wait = windows.wait ?? DEFAULT_WAIT_HOURS
  const warnings: string[] = []
  for (const row of rows) {
    const p90 = (row.p90_s ?? 0) / 3600
    const max = (row.max_s ?? 0) / 3600
    if (p90 > wait) {
      warnings.push(
        `${row.label}: 9 из 10 постов — до ${formatNumber(round(p90))} ч, дольше «ждём» ${formatNumber(wait)} ч`,
      )
    }
    if (windows.notOut !== null && max > windows.notOut) {
      warnings.push(
        `${row.label}: до ${formatNumber(round(max))} ч, дольше «не вышло» ${formatNumber(windows.notOut)} ч`,
      )
    }
  }
  return {
    typical_hours: round((all[0]?.median_s ?? 0) / 3600),
    max_hours: round((all[0]?.max_s ?? 0) / 3600),
    wait_window_hours: wait,
    warning: warnings.length > 0 ? warnings.join(' · ') : null,
  }
}

/** The global «ждём Hub» and «не вышло» windows, in hours; no value — not set. */
async function thresholds(q: Queryable): Promise<{ wait: number | null; notOut: number | null }> {
  const { rows } = await q.execute<{ key: string; value: unknown }>(sql`
    SELECT key, value FROM policy_settings
     WHERE key IN ('hub_wait_window', 'hub_not_out_window')
       AND model_id IS NULL AND account_id IS NULL AND item_type IS NULL`)
  const value = (key: string) => {
    const found = rows.find((row) => row.key === key)?.value
    return typeof found === 'number' ? found : null
  }
  return { wait: value('hub_wait_window'), notOut: value('hub_not_out_window') }
}
