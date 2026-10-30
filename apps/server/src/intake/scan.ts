import { type Db, type PeriodicStream, WorkError, type WorkHandler } from '@contentops/db'
import { isSourceError, type SourceEntry } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import {
  type ApplyStats,
  addStats,
  applyEntries,
  type FolderRef,
  markLosses,
  resolveFolders,
} from './discover'
import { FREEZE_DATASET, freezeSource } from './freeze'
import {
  cloudSources,
  hasCredentials,
  type SourceFactory,
  type SourceRow,
  sourceById,
} from './source-client'

/**
 * The `scan` work of a cloud source (SPEC §6.1): every 5 minutes the fresh changes, every
 * night a full traversal (moves, replacements, losses). A recent window that does not reach
 * the previous scan becomes a full traversal at once. The cursor of the source lives in the
 * report of the last successful scan; an interrupted traversal writes no losses.
 */

export const RECENT_SCAN_MS = 5 * 60 * 1000
export const FULL_SCAN_MS = 24 * 60 * 60 * 1000
/** Entries per transaction of a traversal. */
const BATCH = 200

export type ScanMode = 'recent' | 'full'

export interface ScanReport extends ApplyStats {
  mode: ScanMode
  complete?: boolean
  started_at?: string
  incomplete_dirs?: number
  losses?: number
  cursor: string | null
  /** The scan did nothing: this snapshot of the source is not finished yet (SPEC §6.3). */
  waiting_for_snapshot?: string
}

/** Streams of the scheduler: two per configured cloud source of an active model. */
export async function scanStreams(
  db: Db,
  env: Record<string, string | undefined>,
  since: Date,
): Promise<PeriodicStream[]> {
  const sources = (await cloudSources(db)).filter((source) => hasCredentials(env, source))
  if (sources.length === 0) return []
  // A token the source refused is not tried again until it changes: a new token means a
  // restart of the stack, so only a refusal seen by this process holds the stream.
  const { rows } = await db.execute<{ scope: string }>(sql`
    SELECT DISTINCT ON (scope) scope, error_code, finished_at FROM work_operations
     WHERE kind = 'scan' AND state IN ('succeeded', 'failed')
       AND scope = ANY (${sql.param(sources.map((source) => source.id))}::text[])
     ORDER BY scope, finished_at DESC`)
  const refused = new Set(
    (rows as { scope: string; error_code: string | null; finished_at: string }[])
      .filter((row) => row.error_code === 'auth_rejected' && new Date(row.finished_at) > since)
      .map((row) => row.scope),
  )
  return sources
    .filter((source) => !refused.has(source.id))
    .flatMap((source) => [
      {
        streamKey: `scan:${source.id}`,
        kind: 'scan' as const,
        modelId: source.modelId,
        intervalMs: RECENT_SCAN_MS,
        priority: 20,
        scope: source.id,
        dataset: 'recent',
      },
      {
        streamKey: `scan-full:${source.id}`,
        kind: 'scan' as const,
        modelId: source.modelId,
        intervalMs: FULL_SCAN_MS,
        priority: 15,
        scope: source.id,
        dataset: 'full',
      },
    ])
}

/**
 * The report of the last successful scan of a source: its cursor and traversal start. The
 * snapshot `scan:freeze` is a scan of its own and carries neither.
 */
async function lastReport(db: Db, sourceId: string, where = sql`true`): Promise<ScanReport | null> {
  const { rows } = await db.execute<{ report: ScanReport }>(sql`
    SELECT report FROM work_operations
     WHERE kind = 'scan' AND scope = ${sourceId} AND state = 'succeeded' AND report IS NOT NULL
       AND dataset IS DISTINCT FROM ${FREEZE_DATASET} AND ${where}
     ORDER BY finished_at DESC LIMIT 1`)
  return rows[0]?.report ?? null
}

/**
 * The snapshot of the source that is queued or under way (SPEC §6.3). Until it pins its
 * revisions an ordinary scan would take the whole old disk as new files — groups, drafts and
 * downloads of everything — and with no cursor yet its first window is a full traversal: so
 * it waits. The snapshot outranks nothing in the queue (`priority` 5 < 15, 20).
 */
async function unfinishedSnapshot(db: Db, sourceId: string): Promise<string | null> {
  const { rows } = await db.execute<{ work_key: string }>(sql`
    SELECT work_key FROM work_operations
     WHERE kind = 'scan' AND scope = ${sourceId} AND dataset = ${FREEZE_DATASET}
       AND state IN ('pending', 'running', 'retry_wait')
     ORDER BY created_at LIMIT 1`)
  return rows[0]?.work_key ?? null
}

/** Source errors as work outcomes (SPEC §8): a refused token stops, 429 waits, 5xx retries. */
export function scanFailure(error: unknown): unknown {
  if (!isSourceError(error)) return error
  switch (error.kind) {
    case 'auth_rejected':
      return new WorkError('permanent', 'auth_rejected', 'токен не принят', { cause: error })
    case 'rate_limited':
      return new WorkError('transient', 'rate_limited', error.message, {
        ...(error.retryAfterMs == null ? {} : { retryAfterMs: error.retryAfterMs }),
        cause: error,
      })
    case 'not_found':
      return new WorkError('permanent', 'root_not_found', 'папки модели нет у источника', {
        cause: error,
      })
    default:
      return new WorkError('transient', error.kind, error.message, { cause: error })
  }
}

export function scanHandler(factory: SourceFactory): WorkHandler {
  return async (context) => {
    const { work, db, signal, checkpoint } = context
    const source = work.scope ? await sourceById(db, work.scope) : undefined
    if (!source) throw new WorkError('permanent', 'source_missing', 'источника нет')
    const client = factory(source)
    if (!client) {
      throw new WorkError('permanent', 'not_configured', `нет ${source.credentialsRef} в окружении`)
    }
    if (work.dataset === FREEZE_DATASET) {
      // The snapshot of stage 3 (SPEC §6.3): only by the operator's command.
      try {
        return await freezeSource(context, source, client)
      } catch (error) {
        throw scanFailure(error)
      }
    }
    const previous = await lastReport(db, source.id)
    const snapshot = await unfinishedSnapshot(db, source.id)
    if (snapshot) {
      const mode: ScanMode = work.dataset === 'full' ? 'full' : 'recent'
      const report: ScanReport = {
        mode,
        cursor: previous?.cursor ?? null,
        files: 0,
        dirs: 0,
        revisions: 0,
        drafts: 0,
        moved: 0,
        waiting_for_snapshot: snapshot,
      }
      return { report }
    }
    const folders = new Map<string, FolderRef>()
    const apply = async (entries: readonly SourceEntry[]) => {
      await resolveFolders(db, client, source, entries, folders, signal)
      return applyEntries(db, { source, client, workId: work.id, entries, folders })
    }
    try {
      if (work.dataset !== 'full') {
        const recent = await client.recent(previous?.cursor ?? null, { signal })
        if (!recent.fullTraversal) {
          const stats = await apply(recent.entries)
          return { report: { mode: 'recent', cursor: recent.cursor, ...stats } }
        }
        return {
          report: await traverse(
            db,
            source,
            work.id,
            apply,
            client,
            signal,
            checkpoint,
            recent.cursor,
          ),
        }
      }
      return {
        report: await traverse(
          db,
          source,
          work.id,
          apply,
          client,
          signal,
          checkpoint,
          previous?.cursor ?? null,
        ),
      }
    } catch (error) {
      throw scanFailure(error)
    }
  }
}

async function traverse(
  db: Db,
  source: SourceRow,
  workId: string,
  apply: (entries: readonly SourceEntry[]) => Promise<ApplyStats>,
  client: NonNullable<ReturnType<SourceFactory>>,
  signal: AbortSignal,
  checkpoint: Parameters<WorkHandler>[0]['checkpoint'],
  cursor: string | null,
): Promise<ScanReport> {
  const { rows } = await db.execute<{ at: string }>(sql`SELECT now()::text AS at`)
  const startedAt = (rows[0] as { at: string }).at
  const stats: ApplyStats = { files: 0, dirs: 0, revisions: 0, drafts: 0, moved: 0 }
  let batch: SourceEntry[] = []
  let complete = false
  let incompleteDirs = 0
  let endCursor: string | null = null
  const flush = async () => {
    if (batch.length === 0) return
    addStats(stats, await apply(batch))
    batch = []
    await checkpoint({ progress: { num: stats.files, note: `${stats.files} файлов` } })
  }
  for await (const event of client.traverse(undefined, { signal })) {
    if (event.type === 'entry') {
      batch.push(event.entry)
      if (batch.length >= BATCH) await flush()
    } else if (event.type === 'end') {
      complete = event.complete
      incompleteDirs = event.incompleteDirs
      endCursor = event.cursor
    }
  }
  await flush()
  let losses = 0
  if (complete) {
    const prior = await lastReport(
      db,
      source.id,
      sql`report ->> 'mode' = 'full' AND report ->> 'complete' = 'true'`,
    )
    if (prior?.started_at) losses = await markLosses(db, source, workId, prior.started_at)
  }
  return {
    mode: 'full',
    complete,
    started_at: startedAt,
    incomplete_dirs: incompleteDirs,
    losses,
    cursor: endCursor ?? cursor,
    ...stats,
  }
}
