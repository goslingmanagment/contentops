import {
  type Db,
  isSwitchOn,
  LeaseLostError,
  type PeriodicStream,
  RunnerStoppedError,
  SYSTEM_ACTOR,
  type Tx,
  values,
  type WorkContext,
  WorkDeferred,
  WorkError,
  type WorkHandler,
  withActorTx,
} from '@contentops/db'
import {
  checkCapabilities,
  createHubClient,
  type DatasetPage,
  type DatasetRow,
  describeProblem,
  HUB_POLL_INTERVAL_MS,
  type HubCapabilities,
  type HubClient,
  type HubDataset,
  isHubError,
  type PollPlan,
  type ReadDatasetOptions,
} from '@contentops/hub'
import { sql } from 'drizzle-orm'
import {
  HubFormatError,
  knownPosts,
  type MirrorScope,
  mirrorPosts,
  mirrorRawMedia,
  mirrorVault,
  observe,
  replaceAttachments,
} from './mirror'
import {
  failedSinceSuccess,
  markRebuilt,
  type PageRef,
  type PostsCoverage,
  planRun,
  type RunOutcome,
  readState,
  saveFailure,
  saveSuccess,
} from './state'

/**
 * The hourly Hub poll of a page (SPEC §7, §8, §8.1; PLAN 5), work `hub_sync` of role `worker`,
 * one periodic stream per page and dataset (`hub:<account>:<dataset>`, the hour in
 * `work_key`):
 *
 * - every run starts with `capabilities`: a pinned field gone or of another type, a dataset
 *   gone or a page not granted stops the poll of the page with the reason (extra fields are
 *   fine);
 * - `posts` reads posts and their attachments by `rowUpdatedAt` from the last success minus
 *   3 h (once a day minus a day), replaces the attachment set of every affected post whole,
 *   then reads `sync_streams` and `capture_coverage` whole (Hub's freshness and coverage);
 *   `raw_media`, `vault_media` (Fansly) read the same way; `creator_stats` (Fansly) reads views
 *   and likes per file per day by a window of days;
 * - a full re-read at the first run, a month after the last one, after a failed run, after a
 *   Hub rebuild (a refused cursor) and after a gap longer than a day;
 * - a 401/403 stops the stream for good: no retries until the key changes (a restart);
 *   429, 5xx and a cut answer are retried by the client and then by the executor's backoff;
 * - the switch «Получать данные» is checked before every request: switched off, the run gives
 *   its work back and the gate holds it with `switch_off:hub.receive`; what was saved stays,
 *   the boundary does not move, and switching on catches up without duplicates.
 */

export type HubClientFactory = () => HubClient | null

/** The client of the key in the environment; without the key or the address — none (SPEC §8). */
export function envHubClient(env: {
  HUB_BASE_URL?: string | undefined
  HUB_API_KEY?: string | undefined
}): HubClientFactory {
  const { HUB_BASE_URL: baseUrl, HUB_API_KEY: key } = env
  if (!baseUrl || !key) return () => null
  const client = createHubClient({ baseUrl, key })
  return () => client
}

const STREAMS_OF: Record<values.Platform, readonly values.HubSyncDataset[]> = {
  fansly: ['posts', 'raw_media', 'vault_media', 'creator_stats'],
  // Hub gives neither the OnlyFans vault (E4) nor its statistics (SPEC §8.1).
  onlyfans: ['posts', 'raw_media'],
}

/** Hub datasets each stream reads. */
const DATASETS_OF: Record<values.HubSyncDataset, readonly HubDataset[]> = {
  posts: ['posts', 'post_attachments', 'capture_coverage', 'sync_streams'],
  raw_media: ['raw_media'],
  vault_media: ['vault_media'],
  creator_stats: ['creator_stats_media_daily', 'creator_stats_media_likes'],
}

/** Views and likes per file per day exist in Hub from this day (SPEC §8.1). */
export const HUB_STATS_FROM = '2026-10-22T00:00:00.000Z'
const DAY_MS = 24 * 60 * 60_000
/** Days of statistics each read takes again: they settle on the next day. */
const STATS_DAYS: Record<PollPlan['mode'], number> = { hourly: 3, daily: 8, full: 40 }
/** Hub answers 500 to an `in` filter of 50 values (30.10.2026): refs go in smaller groups. */
const IN_LIMIT = 25
/** Posts whose attachment sets one transaction replaces. */
const SET_BATCH = 100

interface Page extends PageRef {
  platform: values.Platform
  code: string
  hubPage: string | null
}

async function pageOf(db: Db, accountId: string | null): Promise<Page | null> {
  if (!accountId) return null
  const { rows } = await db.execute<{
    model_id: string
    id: string
    platform: values.Platform
    code: string
    hub_page_ref: string | null
  }>(
    sql`SELECT model_id, id, platform, code, hub_page_ref FROM accounts WHERE id = ${accountId}::uuid`,
  )
  const row = rows[0]
  if (!row) return null
  return {
    modelId: row.model_id,
    accountId: row.id,
    platform: row.platform,
    code: row.code,
    hubPage: row.hub_page_ref,
  }
}

/**
 * Streams of the scheduler: one per page and dataset, for pages with a Hub page code whose
 * «Получать данные» is on. Nothing without the key in the environment; a key Hub refused since
 * this process started is not tried again until it changes (a new key means a restart).
 */
export async function hubStreams(
  db: Db,
  options: { configured: boolean; since: Date },
): Promise<PeriodicStream[]> {
  if (!options.configured) return []
  const { rows: refused } = await db.execute(sql`
    SELECT 1 FROM work_operations
     WHERE kind = 'hub_sync' AND state = 'failed' AND error_code = 'auth_rejected'
       AND finished_at > ${options.since.toISOString()}::timestamptz
     LIMIT 1`)
  if (refused.length > 0) return []
  const { rows: pages } = await db.execute<{
    model_id: string
    id: string
    platform: values.Platform
  }>(sql`
    SELECT a.model_id, a.id, a.platform FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE a.hub_page_ref IS NOT NULL AND a.archived_at IS NULL AND m.archived_at IS NULL
     ORDER BY a.model_id, a.position, a.id`)
  const streams: PeriodicStream[] = []
  for (const page of pages) {
    const scope = { modelId: page.model_id, accountId: page.id }
    if (!(await isSwitchOn(db, 'hub.receive', scope))) continue
    for (const dataset of STREAMS_OF[page.platform]) {
      streams.push({
        streamKey: `hub:${page.id}:${dataset}`,
        kind: 'hub_sync',
        modelId: page.model_id,
        accountId: page.id,
        dataset,
        intervalMs: HUB_POLL_INTERVAL_MS,
        priority: dataset === 'posts' ? 10 : 5,
        windowed: true,
      })
    }
  }
  return streams
}

/** Problems of the capabilities that stop the poll of this page, as reasons. */
export function capabilityProblems(caps: HubCapabilities, page: Page): string[] {
  const reasons: string[] = []
  if (caps.pages.length > 0 && !caps.pages.some((p) => p.pageLabel === page.hubPage)) {
    reasons.push(`ключу Hub не выдана страница ${page.hubPage}`)
  }
  const check = checkCapabilities(caps)
  const needed = new Set(STREAMS_OF[page.platform].flatMap((stream) => DATASETS_OF[stream]))
  for (const dataset of needed) {
    for (const problem of check.datasets[dataset].problems) {
      reasons.push(describeProblem(dataset, problem))
    }
  }
  return reasons
}

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

class Run {
  readonly scope: MirrorScope
  readonly blockers = new Set<string>()
  private requests = 0

  constructor(
    readonly context: WorkContext,
    readonly client: HubClient,
    readonly page: Page & { hubPage: string },
    readonly plan: PollPlan,
    readonly startedAt: Date,
    private readonly limit: number | undefined,
  ) {
    this.scope = {
      modelId: page.modelId,
      accountId: page.accountId,
      workId: context.work.id,
      attempt: context.work.attemptNo,
    }
  }

  /** New requests stop as soon as «Получать данные» is off (SPEC §8). */
  async guard(): Promise<void> {
    const on = await isSwitchOn(this.context.db, 'hub.receive', {
      modelId: this.page.modelId,
      accountId: this.page.accountId,
    })
    if (!on) throw new WorkDeferred(0, 'Hub выключен для страницы')
  }

  /** Pages of a dataset read; the switch is checked before each request. */
  async *read<D extends HubDataset>(
    dataset: D,
    options: Omit<ReadDatasetOptions<D>, 'page' | 'signal' | 'limit'>,
  ): AsyncGenerator<DatasetPage<D>, void, undefined> {
    const pages = this.client.readDataset(dataset, {
      ...options,
      page: this.page.hubPage,
      signal: this.context.signal,
      ...(this.limit ? { limit: this.limit } : {}),
    } as ReadDatasetOptions<D>)
    try {
      for (;;) {
        await this.guard()
        const next = await pages.next()
        if (next.done) return
        this.requests += 1
        for (const blocker of next.value.blockers) this.blockers.add(blocker)
        yield next.value
      }
    } finally {
      await pages.return(undefined)
    }
  }

  /** One transaction of mirror writes, with the journal context of the work. */
  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const { work } = this.context
    return withActorTx(
      this.context.db,
      {
        actor: SYSTEM_ACTOR('hub'),
        action: 'hub.sync',
        requestId: `work:${work.id}:${work.fenceGeneration}`,
        workId: work.id,
      },
      fn,
    )
  }

  /** Progress under the lease: a holder that lost it stops here. */
  progress(rows: number, note: string): Promise<void> {
    return this.context.checkpoint({ progress: { num: rows, note } })
  }

  get requestCount(): number {
    return this.requests
  }
}

interface StreamResult {
  outcome: Omit<RunOutcome, 'blockers'>
  counts: Record<string, number>
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

async function syncPosts(run: Run): Promise<StreamResult> {
  const since = run.plan.updatedSince ?? undefined
  const counts: Record<string, number> = {
    posts: 0,
    posts_changed: 0,
    attachments: 0,
    attachments_changed: 0,
    attachments_removed: 0,
    slot_conflicts: 0,
    orphan_attachments: 0,
  }
  const seen = new Set<string>()
  const mirror = async (rows: readonly DatasetRow<'posts'>[]) => {
    const result = await run.write((tx) => mirrorPosts(tx, run.scope, rows))
    for (const ref of result.refs) seen.add(ref)
    counts.posts = (counts.posts ?? 0) + result.rows
    counts.posts_changed = (counts.posts_changed ?? 0) + result.changed
    await run.progress(seen.size, 'посты')
  }
  for await (const page of run.read('posts', since ? { updatedSince: since } : {})) {
    await mirror(page.rows)
  }

  // The affected posts and their whole attachment sets.
  const sets = new Map<string, DatasetRow<'post_attachments'>[]>()
  if (run.plan.mode === 'full') {
    for (const ref of seen) sets.set(ref, [])
    for await (const page of run.read('post_attachments', {})) {
      for (const row of page.rows) {
        const ref = str(row.fields.postRef)
        if (ref) push(sets, ref, row)
      }
    }
  } else {
    const touched = new Set(seen)
    for await (const page of run.read('post_attachments', { updatedSince: since })) {
      for (const row of page.rows) {
        const ref = str(row.fields.postRef)
        if (ref) touched.add(ref)
      }
    }
    for (const group of chunks([...touched], IN_LIMIT)) {
      for (const ref of group) sets.set(ref, [])
      const filters = [{ field: 'postRef', op: 'in' as const, value: group }]
      for await (const page of run.read('post_attachments', { filters })) {
        for (const row of page.rows) {
          const ref = str(row.fields.postRef)
          if (ref && sets.has(ref)) push(sets, ref, row)
        }
      }
    }
  }
  // An attachment of a post the mirror does not hold yet: the post comes first.
  const unknown = [...sets.keys()].filter((ref) => !seen.has(ref))
  const known = await knownPosts(run.context.db, run.scope, unknown)
  for (const group of chunks(
    unknown.filter((ref) => !known.has(ref)),
    IN_LIMIT,
  )) {
    const filters = [{ field: 'postRef', op: 'in' as const, value: group }]
    for await (const page of run.read('posts', { filters })) await mirror(page.rows)
  }
  let done = 0
  for (const group of chunks([...sets.keys()], SET_BATCH)) {
    const part = new Map(group.map((ref) => [ref, sets.get(ref) ?? []]))
    const result = await run.write((tx) => replaceAttachments(tx, run.scope, part))
    counts.attachments = (counts.attachments ?? 0) + result.rows
    counts.attachments_changed = (counts.attachments_changed ?? 0) + result.changed
    counts.attachments_removed = (counts.attachments_removed ?? 0) + result.removed
    counts.slot_conflicts = (counts.slot_conflicts ?? 0) + result.slotConflicts
    counts.orphan_attachments =
      (counts.orphan_attachments ?? 0) +
      result.missingPosts.reduce((sum, ref) => sum + (sets.get(ref)?.length ?? 0), 0)
    done += group.length
    await run.progress(done, 'вложения')
  }

  // Hub's own freshness and coverage, read whole.
  const streams: DatasetRow<'sync_streams'>[] = []
  for await (const page of run.read('sync_streams', {})) streams.push(...page.rows)
  const coverage: DatasetRow<'capture_coverage'>[] = []
  for await (const page of run.read('capture_coverage', {})) coverage.push(...page.rows)
  const hubPosts = streams.find((row) => row.fields.stream === 'posts')
  return {
    outcome: {
      // Fansly pages have no `sync_streams` rows: the freshness is Hub's latest sighting of a
      // post of the page (its posts reader touches them every few hours).
      hubSucceededAt: hubPosts ? hubPosts.fields.succeededAt : await latestPostSighting(run),
      consecutiveFailures: hubPosts?.fields.consecutiveFailures ?? 0,
      hubUnavailable:
        hubPosts?.fields.syncStatus === 'paused' ? 'Hub приостановил свой поток постов' : null,
      coverage: postsCoverage(coverage),
    },
    counts: { ...counts, sync_streams: streams.length, coverage_rows: coverage.length },
  }
}

async function latestPostSighting(run: Run): Promise<string | null> {
  const { rows } = await run.context.db.execute<{ at: string | null }>(sql`
    SELECT max(last_observed_at)::text AS at FROM hub_posts
     WHERE model_id = ${run.scope.modelId}::uuid AND account_id = ${run.scope.accountId}::uuid`)
  return rows[0]?.at ? new Date(rows[0].at).toISOString() : null
}

/**
 * The posts plan of `capture_coverage` with proof (entry E7, schema §9.6). Hub has none on
 * 30.10.2026: the columns stay NULL and «не вышло» by posts stays off.
 */
function postsCoverage(rows: readonly DatasetRow<'capture_coverage'>[]): PostsCoverage | null {
  const plan = rows.find(
    (row) =>
      row.fields.plane === 'posts' &&
      row.fields.status === 'provider_exhausted' &&
      row.fields.proof !== null &&
      row.fields.proof !== 'none',
  )
  if (!plan) return null
  const f = plan.fields
  return {
    windowFrom: f.oldestCapturedAt,
    windowTo: f.newestCapturedAt,
    expectedCount: f.expectedCount,
    observedCount: f.observedUniqueCount,
    stopReason: f.reasonCode,
    provenCompleteAt: f.updatedAt,
  }
}

async function syncRawMedia(run: Run): Promise<StreamResult> {
  const since = run.plan.updatedSince ?? undefined
  const counts = { files: 0, files_changed: 0 }
  for await (const page of run.read('raw_media', since ? { updatedSince: since } : {})) {
    const result = await run.write((tx) => mirrorRawMedia(tx, run.scope, page.rows))
    counts.files += result.rows
    counts.files_changed += result.changed
    await run.progress(counts.files, 'файлы')
  }
  return { outcome: {}, counts }
}

async function syncVault(run: Run): Promise<StreamResult> {
  const since = run.plan.updatedSince ?? undefined
  const counts = { members: 0, members_changed: 0 }
  const filters = [{ field: 'vaultKind', op: 'eq' as const, value: 'creator' }]
  for await (const page of run.read('vault_media', {
    filters,
    ...(since ? { updatedSince: since } : {}),
  })) {
    const result = await run.write((tx) => mirrorVault(tx, run.scope, page.rows))
    counts.members += result.rows
    counts.members_changed += result.changed
    await run.progress(counts.members, 'vault')
  }
  // Freshness of the vault is Hub's latest full walk of an album.
  const { rows } = await run.context.db.execute<{ at: string | null }>(sql`
    SELECT max(last_full_walk_at)::text AS at FROM hub_vault_albums
     WHERE model_id = ${run.scope.modelId}::uuid AND account_id = ${run.scope.accountId}::uuid`)
  return {
    outcome: { hubSucceededAt: rows[0]?.at ? new Date(rows[0].at).toISOString() : null },
    counts,
  }
}

async function syncStats(run: Run, firstRun: boolean): Promise<StreamResult> {
  const floor = Date.parse(HUB_STATS_FROM)
  const from = firstRun
    ? floor
    : Math.max(floor, run.startedAt.getTime() - STATS_DAYS[run.plan.mode] * DAY_MS)
  const window = { from: new Date(from) }
  const counts = { views: 0, views_changed: 0, likes: 0, likes_changed: 0 }
  for await (const page of run.read('creator_stats_media_daily', window)) {
    const observed = await run.write((tx) =>
      observe(tx, run.scope, 'creator_stats_media_daily', page.rows),
    )
    counts.views += observed.size
    counts.views_changed += [...observed.values()].filter((entry) => entry.changed).length
    await run.progress(counts.views, 'просмотры')
  }
  for await (const page of run.read('creator_stats_media_likes', window)) {
    const observed = await run.write((tx) =>
      observe(tx, run.scope, 'creator_stats_media_likes', page.rows),
    )
    counts.likes += observed.size
    counts.likes_changed += [...observed.values()].filter((entry) => entry.changed).length
    await run.progress(counts.likes, 'лайки')
  }
  return { outcome: {}, counts }
}

/** Codes of `work_operations.error_code` a Hub run ends with. */
export const HUB_ERROR_CODES = {
  notConfigured: 'not_configured',
  authRejected: 'auth_rejected',
  pageNotGranted: 'page_not_granted',
  formatChanged: 'format_changed',
  rateLimited: 'rate_limited',
  unavailable: 'hub_unavailable',
  rebuilt: 'hub_rebuilt',
  refused: 'hub_refused',
} as const

function isControl(error: unknown): boolean {
  return (
    error instanceof WorkDeferred ||
    error instanceof LeaseLostError ||
    error instanceof RunnerStoppedError ||
    error instanceof WorkError
  )
}

/** Hub's answers as work outcomes, with what the stream state should say. */
function failureOf(error: unknown): { error: unknown; unavailable: string | null } {
  if (error instanceof HubFormatError) {
    return {
      error: new WorkError('permanent', HUB_ERROR_CODES.formatChanged, error.message),
      unavailable: `format_changed: ${error.message}`,
    }
  }
  if (!isHubError(error)) return { error, unavailable: null }
  switch (error.kind) {
    case 'auth_rejected':
      return {
        error: new WorkError('permanent', HUB_ERROR_CODES.authRejected, 'токен не принят', {
          cause: error,
        }),
        unavailable: `token_rejected: ${error.at.toISOString()}`,
      }
    case 'rate_limited':
      return {
        error: new WorkError('transient', HUB_ERROR_CODES.rateLimited, error.message, {
          ...(error.retryAfterMs == null ? {} : { retryAfterMs: error.retryAfterMs }),
          cause: error,
        }),
        unavailable: null,
      }
    case 'transient':
      return {
        error: new WorkError('transient', HUB_ERROR_CODES.unavailable, error.message, {
          cause: error,
        }),
        unavailable: null,
      }
    case 'bad_response':
      // A pinned field of another kind in a row, or an answer that is not the contract: the
      // next hourly run tries again from scratch.
      return {
        error: new WorkError('permanent', HUB_ERROR_CODES.formatChanged, error.message, {
          cause: error,
        }),
        unavailable: `format_changed: ${error.message}`,
      }
    case 'refused':
      return {
        error: new WorkError(
          'permanent',
          HUB_ERROR_CODES.refused,
          `Hub отказал: ${error.code ?? error.status}`,
          { cause: error },
        ),
        unavailable: null,
      }
  }
}

export interface HubSyncOptions {
  client: HubClientFactory
  /** Rows per request (default Hub's 200). */
  pageSize?: number
}

export function hubSyncHandler(options: HubSyncOptions): WorkHandler {
  return async (context) => {
    const { work, db } = context
    const dataset = values.hubSyncDatasets.find((name) => name === work.dataset)
    if (!dataset) throw new WorkError('permanent', 'bad_stream', `нет потока ${work.dataset}`)
    const page = await pageOf(db, work.accountId)
    if (!page?.hubPage) {
      throw new WorkError('permanent', HUB_ERROR_CODES.notConfigured, 'у страницы нет кода Hub')
    }
    const client = options.client()
    if (!client) {
      throw new WorkError('permanent', HUB_ERROR_CODES.notConfigured, 'нет HUB_API_KEY в окружении')
    }
    const hubPage = page.hubPage
    const record = (failure: { error: unknown; unavailable: string | null }) =>
      withActorTx(
        db,
        {
          actor: SYSTEM_ACTOR('hub'),
          action: 'hub.sync.failed',
          requestId: `work:${work.id}:${work.fenceGeneration}:failed`,
          workId: work.id,
        },
        (tx) =>
          saveFailure(tx, page, dataset, {
            workId: work.id,
            error: failure.error instanceof Error ? failure.error.message : String(failure.error),
            unavailable: failure.unavailable,
          }),
      ).catch(() => undefined)
    try {
      context.signal.throwIfAborted()
      const caps = await client.capabilities(context.signal)
      const problems = capabilityProblems(caps, { ...page, hubPage })
      if (problems.length > 0) {
        const notGranted = problems.some((reason) => reason.startsWith('ключу Hub не выдана'))
        const reason = problems.join('; ')
        throw new WorkError(
          'permanent',
          notGranted ? HUB_ERROR_CODES.pageNotGranted : HUB_ERROR_CODES.formatChanged,
          reason,
        )
      }
      const { rows: clock } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)
      const startedAt = new Date((clock[0] as { now: string }).now)
      const state = await readState(db, page, dataset)
      const failed = await failedSinceSuccess(db, page, dataset, state.lastSuccessAt)
      const plan = planRun(state, startedAt, failed)
      const run = new Run(context, client, { ...page, hubPage }, plan, startedAt, options.pageSize)
      let result: StreamResult
      switch (dataset) {
        case 'posts':
          result = await syncPosts(run)
          break
        case 'raw_media':
          result = await syncRawMedia(run)
          break
        case 'vault_media':
          result = await syncVault(run)
          break
        case 'creator_stats':
          result = await syncStats(run, state.lastSuccessAt === null)
          break
      }
      const outcome: RunOutcome = { ...result.outcome, blockers: [...run.blockers].sort() }
      return {
        report: {
          dataset,
          mode: plan.mode,
          ...(plan.mode === 'full' ? { reason: plan.reason } : {}),
          updated_since: plan.updatedSince?.toISOString() ?? null,
          started_at: startedAt.toISOString(),
          requests: run.requestCount,
          ...result.counts,
          blockers: outcome.blockers,
          hub_succeeded_at: outcome.hubSucceededAt ?? null,
        },
        // The boundary moves with the finish of the work, only for the holder of the lease.
        commit: (tx) =>
          saveSuccess(tx, page, dataset, { plan, startedAt, workId: work.id, outcome }),
      }
    } catch (error) {
      if (isHubError(error, 'refused', 'agent_cursor_invalid')) {
        // A cursor minted before a Hub rebuild: the next attempt re-reads in full.
        await withActorTx(
          db,
          {
            actor: SYSTEM_ACTOR('hub'),
            action: 'hub.sync.rebuilt',
            requestId: `work:${work.id}:${work.fenceGeneration}:rebuilt`,
            workId: work.id,
          },
          (tx) => markRebuilt(tx, page, dataset, work.id),
        )
        throw new WorkError('transient', HUB_ERROR_CODES.rebuilt, 'Hub пересобран: перечитываем', {
          cause: error,
        })
      }
      if (error instanceof WorkError) {
        if (error.code === HUB_ERROR_CODES.formatChanged) {
          await record({ error, unavailable: `format_changed: ${error.message}` })
        } else if (error.code === HUB_ERROR_CODES.pageNotGranted) {
          await record({ error, unavailable: `page_not_granted: ${error.message}` })
        }
        throw error
      }
      if (isControl(error)) throw error
      const failure = failureOf(error)
      if (failure.error !== error) await record(failure)
      throw failure.error
    }
  }
}
