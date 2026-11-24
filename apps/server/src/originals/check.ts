import { type Queryable, WorkError, type WorkHandler } from '@contentops/db'
import { DigestSet, type Digests } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { type ConfiguredModel, configuredModels, PC_HOLDERS } from './config'
import { addEnrol, type EnrolReport, emptyEnrol, enrolOriginals } from './enrol'
import { type OriginalState, originalStates } from './rule'
import { DEFAULT_LIMITS, DEFAULT_STREAMS, lanes, type StreamLimits, StreamWatch } from './streams'
import { type CloudObject, type OriginalsTransport, TransportError } from './transport'

/**
 * Work `originals_check` of role `worker`, slot `originals` (SPEC §9.4): a copy in MEGA or in a
 * model's Dropbox is checked by its bytes. Every 10 minutes a run of at most 30 minutes goes over
 * the copies not checked yet, `ORIGINALS_STREAMS` at a time (default 8: one MEGA stream gives
 * ~2 MiB/s, ten ~7 MiB/s), started in this order — the ones that free the most of the PC per
 * byte downloaded first: the copy of Я.Диск on C:, then `E:\Ari`, then the rest (an original
 * already in two places last). Per copy:
 *
 * 1. the node under the path now (`stat`): none — not copied yet, again in 12 h (the copy work
 *    `originals_copy` writes it); a node the row did not know — the row takes it (its check, if
 *    any, goes with the old one);
 * 2. another size than the original — wrong bytes without a download;
 * 3. the hashes of that very node are known (an earlier run, another row with the same node and
 *    size) — they are compared and nothing is downloaded; a copy in Dropbox — the Dropbox hash its
 *    listing gives is compared with the original's (its `content_hash`, or the one a check of
 *    another copy computed on the original's bytes); while a MEGA copy of the same original waits
 *    for its check, which computes that hash, the Dropbox copy waits too;
 * 4. otherwise the bytes are streamed back once and MD5, SHA-256 and the Dropbox hash are taken in
 *    one pass; the node must be the same after the stream;
 * 5. all hashes the original has (Я.Диск — MD5 and SHA-256 of the revision, Dropbox — its
 *    `content_hash`, our SHA-256 when the import read it, a web upload — its SHA-256) must match:
 *    then `verified_at`, `verified_by = 'worker:originals'`, the node and the hashes; otherwise
 *    the error, `attempts + 1` and the next try in 24 h. Nothing is copied here.
 *
 * A stream that gives no bytes for 2 minutes, or is slower than 256 KiB/s on top of 10 minutes,
 * is cut: the copy is tried again in 30 minutes. As many cuts in a row as there are streams (at
 * least two) end the run — nothing more is started — so a stalled MEGA never holds the slot.
 */

export const CHECK_INTERVAL_MS = 10 * 60_000
export const CHECKED_BY = 'worker:originals'
export const checkStreamKey = 'originals-check'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** When a copy is tried again after each outcome. */
export const RETRY_MS = {
  stalled: 30 * MINUTE,
  failed: 30 * MINUTE,
  absent: 12 * HOUR,
  mismatch: 24 * HOUR,
  no_reference: 7 * 24 * HOUR,
} as const

export interface CheckOptions extends Partial<StreamLimits> {
  /** The clouds; `null` — no rclone configuration: the work fails at once and says so. */
  transport: () => OriginalsTransport | null
  /** How long one run starts new streams; default 30 min. */
  budgetMs?: number
  /** `ORIGINALS_STREAMS`: streams at once; default 8. */
  streams?: number
  /** Stalls in a row that end the run; default the number of streams, at least 2. */
  stallsToStop?: number
}

interface Settings extends StreamLimits {
  budgetMs: number
  streams: number
  stallsToStop: number
}

export interface CheckReport {
  due: number
  checked: number
  verified: number
  /** Without a download: the node's hashes were known. */
  reused: number
  mismatched: number
  absent: number
  stalled: number
  failed: number
  /** Dropbox copies waiting for the check of the original's MEGA copy. */
  deferred: number
  downloaded_bytes: number
  streams: number
  stopped: 'done' | 'budget' | 'stalled'
  enrolled: EnrolReport
}

/** The hashes a check saw: a Dropbox copy matched by its listing has only the Dropbox one. */
type Seen = { md5: string | null; sha256: string | null; contentHash: string | null }

interface Candidate extends Record<string, unknown> {
  model_id: string
  id: string
  source_revision_id: string | null
  web_upload_id: string | null
  place: 'mega' | 'dropbox'
  remote: string
  path: string
  object_ref: string | null
  byte_size: string | null
  copied_at: string | null
  seen_md5: string | null
  seen_sha256: string | null
  seen_dropbox: string | null
  original_size: string
  ref_md5: string | null
  ref_remote_sha256: string | null
  ref_sha256: string | null
  ref_dropbox: string | null
  /** The original's Dropbox hash: its own, or one a check saw on its bytes (Dropbox copies). */
  known_dropbox: string | null
  /** A MEGA copy of the same original waits for its check (Dropbox copies wait for it). */
  mega_pending: boolean
}

type Outcome =
  | { kind: 'verified'; node: CloudObject; digests: Seen; reused: boolean }
  | { kind: 'mismatch'; node: CloudObject; digests: Seen | null; why: string; reused: boolean }
  | { kind: 'absent' }
  | { kind: 'stalled'; why: string }
  | { kind: 'failed'; why: string }
  | { kind: 'no_reference' }
  | { kind: 'deferred' }

/** The other rows of the same original as `c`. */
const sameOriginal = sql`k.model_id = c.model_id AND k.id <> c.id
  AND ((c.source_revision_id IS NOT NULL AND k.source_revision_id = c.source_revision_id)
       OR (c.web_upload_id IS NOT NULL AND k.web_upload_id = c.web_upload_id))`

/**
 * The copies to check, with what their original's bytes must give: every MEGA copy, and the
 * Dropbox copies that have a node (one without a node is the copy work's to write).
 */
async function dueCopies(q: Queryable, models: readonly string[]): Promise<Candidate[]> {
  const { rows } = await q.execute<Candidate>(sql`
    SELECT c.model_id, c.id, c.source_revision_id, c.web_upload_id, c.place, c.remote, c.path,
           c.object_ref, c.byte_size::text AS byte_size, c.copied_at::text AS copied_at,
           encode(c.seen_md5, 'hex') AS seen_md5, encode(c.seen_sha256, 'hex') AS seen_sha256,
           encode(c.seen_dropbox_hash, 'hex') AS seen_dropbox,
           COALESCE(r.byte_size, u.size_expected)::text AS original_size,
           encode(r.md5, 'hex') AS ref_md5, encode(r.remote_sha256, 'hex') AS ref_remote_sha256,
           encode(COALESCE(r.source_sha256, u.sha256), 'hex') AS ref_sha256,
           encode(r.content_hash, 'hex') AS ref_dropbox,
           CASE WHEN c.place = 'dropbox' THEN COALESCE(
             encode(r.content_hash, 'hex'),
             (SELECT encode(k.seen_dropbox_hash, 'hex') FROM original_copies k
               WHERE ${sameOriginal} AND k.verified_at IS NOT NULL AND k.missing_since IS NULL
                 AND k.seen_dropbox_hash IS NOT NULL
                 AND k.byte_size = COALESCE(r.byte_size, u.size_expected)
               ORDER BY k.verified_at DESC LIMIT 1)) END AS known_dropbox,
           (c.place = 'dropbox' AND EXISTS (
              SELECT 1 FROM original_copies k
               WHERE ${sameOriginal} AND k.place = 'mega' AND k.verified_at IS NULL
                 AND k.missing_since IS NULL AND k.object_ref IS NOT NULL AND k.attempts < 3
                 AND (k.error IS NULL OR k.error NOT LIKE 'mismatch:%'))) AS mega_pending
      FROM original_copies c
      LEFT JOIN source_revisions r ON r.model_id = c.model_id AND r.id = c.source_revision_id
      LEFT JOIN web_uploads u ON u.model_id = c.model_id AND u.id = c.web_upload_id
     WHERE c.model_id = ANY (${sql.param([...models])}::uuid[])
       AND c.role = 'copy' AND c.remote IS NOT NULL
       AND (c.place = 'mega' OR (c.place = 'dropbox' AND c.object_ref IS NOT NULL))
       AND c.verified_at IS NULL AND c.missing_since IS NULL
       AND (c.next_try_at IS NULL OR c.next_try_at <= now())
     ORDER BY c.path, c.id`)
  return rows
}

/**
 * 0 — the copy of Я.Диск on C: that this check would let go; 1 — `E:\Ari` the same; 2 — not in
 * two places yet, nothing freed now; 3 — already in two other places.
 */
function rank(state: OriginalState | undefined, onPc: ReadonlySet<string>): number {
  if (!state || state.reliable) return 3
  if (state.decided && onPc.has(state.holder)) return state.holder === 'yandex_disk' ? 0 : 1
  return 2
}

interface Ordered {
  id: string
  model_id: string
  source_revision_id: string | null
  web_upload_id: string | null
}

/**
 * `due` in the order the copies free the PC: the copy of Я.Диск on C: first, then `E:\Ari`, then
 * the rest, an original already in two places last; `lead` — rows before all of them (the copy
 * work: bytes already on our disk). The order inside a rank is kept.
 */
export async function ordered<T extends Ordered>(
  q: Queryable,
  models: readonly ConfiguredModel[],
  due: T[],
  lead: (row: T) => boolean = () => false,
): Promise<T[]> {
  const ranks = new Map<string, number>()
  for (const model of models) {
    if (!due.some((row) => row.model_id === model.id)) continue
    const onPc = new Set<string>(model.config.pc.map((holder) => PC_HOLDERS[holder].kind))
    const states = new Map((await originalStates(q, model.id)).map((state) => [state.id, state]))
    for (const row of due) {
      if (row.model_id !== model.id) continue
      const original = row.source_revision_id ?? row.web_upload_id ?? ''
      ranks.set(row.id, rank(states.get(original), onPc))
    }
  }
  return due
    .map((row, at) => ({ row, at, rank: lead(row) ? -1 : (ranks.get(row.id) ?? 3) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.row)
}

/** What the original's bytes must give; every hash it has must match. */
export function compare(
  row: Pick<Candidate, 'ref_md5' | 'ref_remote_sha256' | 'ref_sha256' | 'ref_dropbox'>,
  digests: Seen,
): string | null {
  const wants: [string, string | null, string | null][] = [
    ['md5', row.ref_md5, digests.md5],
    ['sha256', row.ref_remote_sha256, digests.sha256],
    ['sha256', row.ref_sha256, digests.sha256],
    ['dropbox', row.ref_dropbox, digests.contentHash],
  ]
  for (const [name, want, got] of wants) {
    if (want === null) continue
    if (got === null) return `${name} unknown`
    if (want !== got) return `${name} differs`
  }
  return null
}

export const hasReference = (
  row: Pick<Candidate, 'ref_md5' | 'ref_remote_sha256' | 'ref_sha256' | 'ref_dropbox'>,
) =>
  row.ref_md5 !== null ||
  row.ref_remote_sha256 !== null ||
  row.ref_sha256 !== null ||
  row.ref_dropbox !== null

/** The hashes of this node and size, if a run already saw its bytes. */
async function knownDigests(
  q: Queryable,
  row: Candidate,
  node: CloudObject,
): Promise<Digests | null> {
  const own =
    row.object_ref === node.id && Number(row.byte_size) === node.size && row.seen_sha256 !== null
  if (own) {
    return { md5: row.seen_md5, sha256: row.seen_sha256 as string, contentHash: row.seen_dropbox }
  }
  const { rows } = await q.execute<{ md5: string | null; sha256: string; dropbox: string | null }>(
    sql`
    SELECT encode(seen_md5, 'hex') AS md5, encode(seen_sha256, 'hex') AS sha256,
           encode(seen_dropbox_hash, 'hex') AS dropbox
      FROM original_copies
     WHERE remote = ${row.remote} AND object_ref = ${node.id} AND byte_size = ${node.size}
       AND seen_sha256 IS NOT NULL AND NOT (model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid)
     ORDER BY verified_at DESC NULLS LAST LIMIT 1`,
  )
  const found = rows[0]
  return found ? { md5: found.md5, sha256: found.sha256, contentHash: found.dropbox } : null
}

async function stream(
  transport: OriginalsTransport,
  row: Candidate,
  size: number,
  signal: AbortSignal,
  limits: StreamLimits,
): Promise<{ digests: Digests; bytes: number } | { stalled: string }> {
  const watch = new StreamWatch(size, limits, signal)
  try {
    const body = await transport.open(row.remote, row.path, watch.signal)
    const digests = new DigestSet({ md5: true, contentHash: true })
    let bytes = 0
    for await (const chunk of body) {
      digests.update(chunk)
      bytes += chunk.length
      watch.tick()
      if (watch.signal.aborted) throw watch.signal.reason
    }
    return { digests: digests.digest(), bytes }
  } catch (error) {
    const stalled = watch.stalled
    if (stalled !== null) return { stalled }
    throw error
  } finally {
    watch.stop()
  }
}

/**
 * A copy in Dropbox: its listing carries the Dropbox hash of what it holds, so it is checked by
 * that hash when the original's is known, and by its bytes otherwise.
 */
async function checkDropbox(
  transport: OriginalsTransport,
  row: Candidate,
  node: CloudObject,
  size: number,
  signal: AbortSignal,
  limits: StreamLimits,
  counted: { bytes: number },
): Promise<Outcome> {
  if (node.dropbox && row.known_dropbox) {
    const seen: Seen = { md5: null, sha256: null, contentHash: node.dropbox }
    return node.dropbox === row.known_dropbox
      ? { kind: 'verified', node, digests: seen, reused: true }
      : { kind: 'mismatch', node, digests: seen, why: 'dropbox differs', reused: true }
  }
  if (row.mega_pending) return { kind: 'deferred' }
  if (!hasReference(row)) return { kind: 'no_reference' }
  const got = await stream(transport, row, size, signal, limits)
  if ('stalled' in got) return { kind: 'stalled', why: got.stalled }
  counted.bytes += got.bytes
  if (got.bytes !== size) return { kind: 'failed', why: `the stream ended at ${got.bytes} bytes` }
  const after = await transport.stat(row.remote, row.path, signal)
  if (after?.id !== node.id || after.size !== node.size || after.dropbox !== node.dropbox) {
    return { kind: 'failed', why: 'the file changed during the check' }
  }
  if (node.dropbox && node.dropbox !== got.digests.contentHash) {
    return { kind: 'failed', why: 'the listed Dropbox hash is not of the bytes streamed' }
  }
  const why = compare(row, got.digests)
  return why === null
    ? { kind: 'verified', node, digests: got.digests, reused: false }
    : { kind: 'mismatch', node, digests: got.digests, why, reused: false }
}

async function checkOne(
  q: Queryable,
  transport: OriginalsTransport,
  row: Candidate,
  signal: AbortSignal,
  limits: StreamLimits,
  counted: { bytes: number },
): Promise<Outcome> {
  const node = await transport.stat(row.remote, row.path, signal)
  if (!node) return { kind: 'absent' }
  if (!node.id) return { kind: 'failed', why: 'the cloud gives no node ID' }
  if (row.object_ref !== node.id || Number(row.byte_size) !== node.size) {
    // Another node under the path: the row follows it (it was not checked).
    await q.execute(sql`
      UPDATE original_copies
         SET object_ref = ${node.id}, byte_size = ${node.size},
             copied_at = COALESCE(copied_at, ${node.modTime}::timestamptz), last_seen_at = now(),
             unseen_since = NULL
       WHERE model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid AND verified_at IS NULL`)
  }
  const size = Number(row.original_size)
  if (node.size !== size) {
    return { kind: 'mismatch', node, digests: null, why: 'size differs', reused: false }
  }
  if (row.place === 'dropbox') {
    return checkDropbox(transport, row, node, size, signal, limits, counted)
  }
  if (!hasReference(row)) return { kind: 'no_reference' }
  const known = await knownDigests(q, row, node)
  if (known) {
    const why = compare(row, known)
    return why === null
      ? { kind: 'verified', node, digests: known, reused: true }
      : { kind: 'mismatch', node, digests: known, why, reused: true }
  }
  const got = await stream(transport, row, size, signal, limits)
  if ('stalled' in got) return { kind: 'stalled', why: got.stalled }
  counted.bytes += got.bytes
  if (got.bytes !== size) return { kind: 'failed', why: `the stream ended at ${got.bytes} bytes` }
  const after = await transport.stat(row.remote, row.path, signal)
  if (after?.id !== node.id || after.size !== node.size) {
    return { kind: 'failed', why: 'the node changed during the check' }
  }
  const why = compare(row, got.digests)
  return why === null
    ? { kind: 'verified', node, digests: got.digests, reused: false }
    : { kind: 'mismatch', node, digests: got.digests, why, reused: false }
}

const ms = (value: number) => sql`${value}::bigint * interval '1 millisecond'`
const bytea = (hex: string | null) => sql`decode(${hex}, 'hex')`

async function record(q: Queryable, row: Candidate, outcome: Outcome): Promise<void> {
  const where = sql`model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid
    AND verified_at IS NULL`
  switch (outcome.kind) {
    case 'verified':
      await q.execute(sql`
        UPDATE original_copies
           SET verified_at = now(), verified_by = ${CHECKED_BY},
               object_ref = ${outcome.node.id}, byte_size = ${outcome.node.size},
               seen_md5 = ${bytea(outcome.digests.md5)},
               seen_sha256 = ${bytea(outcome.digests.sha256)},
               seen_dropbox_hash = ${bytea(outcome.digests.contentHash)},
               last_seen_at = now(), unseen_since = NULL, error = NULL, next_try_at = NULL
         WHERE ${where}`)
      return
    case 'mismatch': {
      const digests = outcome.digests
      await q.execute(sql`
        UPDATE original_copies
           SET error = ${`mismatch: ${outcome.why}`},
               attempts = attempts + ${outcome.reused ? 0 : 1},
               next_try_at = now() + ${ms(RETRY_MS.mismatch)},
               seen_md5 = ${digests ? bytea(digests.md5) : sql`seen_md5`},
               seen_sha256 = ${digests ? bytea(digests.sha256) : sql`seen_sha256`},
               seen_dropbox_hash = ${digests ? bytea(digests.contentHash) : sql`seen_dropbox_hash`}
         WHERE ${where} AND object_ref = ${outcome.node.id} AND byte_size = ${outcome.node.size}`)
      return
    }
    case 'absent':
      await q.execute(sql`
        UPDATE original_copies
           SET error = 'absent: no object under the path yet',
               next_try_at = now() + ${ms(RETRY_MS.absent)}
         WHERE ${where}`)
      return
    case 'no_reference':
      await q.execute(sql`
        UPDATE original_copies
           SET error = 'no_reference: the original has no hash to compare with',
               next_try_at = now() + ${ms(RETRY_MS.no_reference)}
         WHERE ${where}`)
      return
    case 'deferred':
      return
    case 'stalled':
    case 'failed':
      await q.execute(sql`
        UPDATE original_copies
           SET error = ${`${outcome.kind === 'stalled' ? 'timeout' : 'failed'}: ${outcome.why}`.slice(0, 2000)},
               attempts = attempts + 1,
               next_try_at = now() + ${ms(RETRY_MS[outcome.kind])}
         WHERE ${where}`)
      return
  }
}

export function checkSettings(options: Omit<CheckOptions, 'transport'>): Settings {
  const streams = Math.max(1, Math.floor(options.streams ?? DEFAULT_STREAMS))
  return {
    budgetMs: options.budgetMs ?? 30 * MINUTE,
    idleMs: options.idleMs ?? DEFAULT_LIMITS.idleMs,
    baseMs: options.baseMs ?? DEFAULT_LIMITS.baseMs,
    minBytesPerSec: options.minBytesPerSec ?? DEFAULT_LIMITS.minBytesPerSec,
    streams,
    stallsToStop: options.stallsToStop ?? Math.max(2, streams),
  }
}

export function originalsCheckHandler(options: CheckOptions): WorkHandler {
  const settings = checkSettings(options)
  return async ({ db, signal, checkpoint }) => {
    const transport = options.transport()
    if (!transport) {
      throw new WorkError('permanent', 'not_configured', 'RCLONE_CONFIG is not set or not there')
    }
    const started = Date.now()
    const { models } = await configuredModels(db)
    const enrolled = emptyEnrol()
    for (const model of models) addEnrol(enrolled, await enrolOriginals(db, model))
    const due = await dueCopies(
      db,
      models.map((model) => model.id),
    )
    const report: CheckReport = {
      due: due.length,
      checked: 0,
      verified: 0,
      reused: 0,
      mismatched: 0,
      absent: 0,
      stalled: 0,
      failed: 0,
      deferred: 0,
      downloaded_bytes: 0,
      streams: settings.streams,
      stopped: 'done',
      enrolled,
    }
    if (due.length === 0) return { report }
    const queue = await ordered(db, models, due)
    const counted = { bytes: 0 }
    let stallsInRow = 0
    const stopped = await lanes(queue, {
      streams: settings.streams,
      signal,
      stop: () => {
        if (stallsInRow >= settings.stallsToStop) return 'stalled'
        return Date.now() - started >= settings.budgetMs ? 'budget' : null
      },
      run: async (row): Promise<Outcome> => {
        try {
          return await checkOne(db, transport, row, signal, settings, counted)
        } catch (error) {
          if (signal.aborted) throw signal.reason
          const why =
            error instanceof TransportError || error instanceof Error
              ? error.message
              : String(error)
          return { kind: 'failed', why }
        }
      },
      done: async (row, outcome) => {
        await record(db, row, outcome)
        if (outcome.kind === 'deferred') {
          report.deferred += 1
          return
        }
        report.checked += 1
        switch (outcome.kind) {
          case 'verified':
            report.verified += 1
            if (outcome.reused) report.reused += 1
            break
          case 'mismatch':
            report.mismatched += 1
            if (outcome.reused) report.reused += 1
            break
          case 'absent':
            report.absent += 1
            break
          case 'stalled':
            report.stalled += 1
            break
          default:
            report.failed += 1
        }
        stallsInRow = outcome.kind === 'stalled' ? stallsInRow + 1 : 0
        report.downloaded_bytes = counted.bytes
        await checkpoint({
          progress: {
            num: report.checked + report.deferred,
            den: queue.length,
            note: `проверено ${report.verified}, не сошлось ${report.mismatched}`,
          },
        })
      },
    })
    if (stopped === 'stalled' || stopped === 'budget') report.stopped = stopped
    return { report }
  }
}
