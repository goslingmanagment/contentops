import { randomUUID } from 'node:crypto'
import { type Db, logAction, type Queryable, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { LocalPathIndex, relativePath } from '@contentops/legacy'
import { DigestSet, type Digests, nfc, sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { compare } from './check'
import { configuredModels, joinPath, remoteText } from './config'
import { DEFAULT_LIMITS, DEFAULT_STREAMS, lanes, type StreamLimits, StreamWatch } from './streams'
import { type CloudObject, type OriginalsTransport, TransportError } from './transport'

/**
 * `ops.js originals mega-dedupe <model> [--yes] [--list]` (SPEC §9.4, ops/README.md «Дубли
 * MEGA»), owner-run: the duplicates of the model's Я.Диск in MEGA go. Before ContentOps copied
 * Я.Диск cloud to cloud, the PC's nightly copy uploaded the files of its local copy, whose names
 * Windows changed (`:` → `-`, spaces at the end of a part → `-`, `apiToLocalPath`); they lie in
 * `<mega>/<copies.yandex_disk>` next to the canonical copies under the Я.Диск names (Lora,
 * 24.11.2026: 356 files, ~513 GiB). The owner's word (24.11.2026): each goes only once the bytes
 * of both nodes are proven the revision's.
 *
 * 1. After a flush of what rclone keeps, the folder is listed whole; a file under a path Я.Диск
 *    ever gave a file of the model, or under a path of the ledger, is canonical and never
 *    touched. Any other file pairs with the one path of Я.Диск whose `apiToLocalPath` it is, if
 *    that path's current revision has its size and an MD5, its canonical copy is listed with the
 *    same size and the ledger has that copy's row. Everything else — nothing explains it, two
 *    paths could (`ambiguous`), another size, no canonical copy, listed twice — is counted by
 *    reason and never touched.
 * 2. Without `--yes` that is all: counts and bytes, nothing downloaded or written.
 * 3. With `--yes`, `ORIGINALS_STREAMS` pairs at a time, the ones whose canonical copy the ledger
 *    has checked first. Per pair: the canonical copy is checked in the ledger with the node
 *    listed now, or its bytes are streamed now (then the ledger keeps the check:
 *    `verified_by = 'ops:mega-dedupe'`); the duplicate's bytes are streamed; both must give
 *    every hash of the revision (MD5 at least), each node the same before and after its stream;
 *    the canonical node is still there; then `removeDuplicate` deletes the duplicate for good —
 *    the fence takes only that node, under `originals/`, never a path or node of the ledger.
 *    A stalled stream is cut as in the check; as many cuts in a row as streams end the run.
 *
 * A repeat lists again and finds what is left. With `--yes` the run goes into the journal, the
 * paths and nodes it deleted included; stdout has counts only, paths with `--list`.
 */

export const DEDUPE_BY = 'ops:mega-dedupe'

export interface DedupeOptions extends Partial<StreamLimits> {
  model: string
  transport: OriginalsTransport
  /** `--yes`: check and delete; without it counts only, nothing downloaded or written. */
  write: boolean
  /** `--list`: the paths of the pairs and of what was left, in the report. */
  list?: boolean
  /** `ORIGINALS_STREAMS`: pairs at once; default 8. */
  streams?: number
  /** Stalls in a row that end the run; default the number of streams, at least 2. */
  stallsToStop?: number
  /** Stops the run: nothing more is started, a delete once sent ends. */
  signal?: AbortSignal
  progress?: (line: string) => void
}

export interface Size {
  files: number
  bytes: number
  gib: number
}

/** Why a file of the folder that is not canonical is not a pair. */
export type SkipReason =
  | 'listed_twice'
  | 'unexplained'
  | 'ambiguous'
  | 'no_revision'
  | 'no_md5'
  | 'size_differs'
  | 'no_canonical'
  | 'canonical_listed_twice'
  | 'canonical_size_differs'
  | 'canonical_not_in_ledger'
  | 'no_node_id'
  | 'ledger_node'

/** Why a pair's duplicate was not deleted. */
export type NotDeleted =
  | 'canonical_mismatch'
  | 'duplicate_mismatch'
  | 'node_changed'
  | 'canonical_changed'
  | 'refused'
  | 'stalled'
  | 'failed'

export interface DedupeReport {
  model: string
  written: boolean
  /** `remote:folder` that was listed. */
  folder: string
  listed: Size
  canonical: Size
  pairs: Size & {
    /** Canonical copies the ledger has checked with the node listed now. */
    canonical_checked: number
    /** The rest: streamed before their duplicate goes. */
    canonical_to_check: Size
    /** What `--yes` downloads at most: every duplicate and the canonical copies to check. */
    download: Size
  }
  skipped: Partial<Record<SkipReason, Size>>
  deleted?: Size
  /** Not there any more when its turn came. */
  gone?: number
  not_deleted?: Partial<Record<NotDeleted, number>>
  /** Canonical copies checked by this run, now checked in the ledger too. */
  canonical_verified?: number
  downloaded?: { bytes: number; gib: number }
  streams?: number
  stopped?: 'done' | 'stalled' | 'interrupted'
  list?: {
    pairs: { duplicate: string; canonical: string; bytes: number; outcome?: string }[]
    skipped: { path: string; bytes: number; why: SkipReason }[]
  }
}

interface Revision {
  id: string
  size: number
  md5: string | null
  remote_sha256: string | null
  source_sha256: string | null
}

interface LedgerRow {
  model_id: string
  id: string
  source_revision_id: string | null
  path: string
  object_ref: string | null
  byte_size: number | null
  verified: boolean
  missing: boolean
  seen_md5: string | null
}

interface Pair {
  /** Paths relative to the folder, as listed. */
  duplicate: CloudObject & { id: string }
  canonical: CloudObject & { id: string }
  revision: Revision
  /** The ledger's row of the canonical copy. */
  row: LedgerRow
  /** Checked in the ledger with the canonical node listed now. */
  checked: boolean
}

type Outcome =
  | { kind: 'deleted'; md5: string; verified: Digests | null }
  | { kind: 'gone'; verified: Digests | null }
  | { kind: NotDeleted; why: string; verified: Digests | null }
  | { kind: 'interrupted'; verified: Digests | null }

const GIB = 1024 ** 3

function size(files: number, bytes: number): Size {
  return { files, bytes, gib: Math.round((bytes / GIB) * 10) / 10 }
}

function add(into: Size, bytes: number): void {
  into.files += 1
  into.bytes += bytes
  into.gib = Math.round((into.bytes / GIB) * 10) / 10
}

const gib = (bytes: number) => (bytes / GIB).toFixed(1)

/** Every path Я.Диск has given a file of the model, relative to its root, NFC. */
async function yandexPaths(q: Queryable, modelId: string): Promise<string[]> {
  const { rows } = await q.execute<{ path: string; root_path: string | null }>(sql`
    SELECT o.current_path AS path, s.root_path FROM source_objects o
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE o.model_id = ${modelId}::uuid AND s.kind = 'yandex_disk' AND NOT o.is_dir
       AND o.archive_revision_id IS NULL
    UNION
    SELECT r.frozen_path, s.root_path FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${modelId}::uuid AND s.kind = 'yandex_disk' AND r.frozen_path IS NOT NULL
       AND NOT o.is_dir AND o.archive_revision_id IS NULL`)
  return rows.map((row) => relativePath(sourcePath(row.path, row.root_path ?? '').relative))
}

/** The current revision under each path of the model's Я.Диск; a live object wins. */
async function revisionsByPath(q: Queryable, modelId: string): Promise<Map<string, Revision>> {
  const { rows } = await q.execute<{
    id: string
    path: string
    root_path: string | null
    size: string
    md5: string | null
    remote_sha256: string | null
    source_sha256: string | null
  }>(sql`
    SELECT r.id, o.current_path AS path, s.root_path, r.byte_size::text AS size,
           encode(r.md5, 'hex') AS md5, encode(r.remote_sha256, 'hex') AS remote_sha256,
           encode(r.source_sha256, 'hex') AS source_sha256
      FROM source_objects o
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
      JOIN source_revisions r ON r.model_id = o.model_id AND r.id = o.current_revision_id
     WHERE o.model_id = ${modelId}::uuid AND s.kind = 'yandex_disk' AND NOT o.is_dir
       AND o.archive_revision_id IS NULL
     ORDER BY o.gone_since NULLS FIRST, r.detected_at DESC`)
  const out = new Map<string, Revision>()
  for (const row of rows) {
    const key = relativePath(sourcePath(row.path, row.root_path ?? '').relative)
    if (out.has(key)) continue
    out.set(key, {
      id: row.id,
      size: Number(row.size),
      md5: row.md5,
      remote_sha256: row.remote_sha256,
      source_sha256: row.source_sha256,
    })
  }
  return out
}

/** Every row of the ledger in the remote, of any model. */
async function ledgerOf(q: Queryable, remote: string): Promise<LedgerRow[]> {
  const { rows } = await q.execute<
    Omit<LedgerRow, 'byte_size'> & { byte_size: string | null } & Record<string, unknown>
  >(sql`
    SELECT model_id, id, source_revision_id, path, object_ref, byte_size::text AS byte_size,
           verified_at IS NOT NULL AS verified, missing_since IS NOT NULL AS missing,
           encode(seen_md5, 'hex') AS seen_md5
      FROM original_copies WHERE remote = ${remote}`)
  return rows.map((row) => ({
    ...row,
    byte_size: row.byte_size === null ? null : Number(row.byte_size),
  }))
}

/** The fence's question: the ledger keeps this path or node for an original (any model). */
export async function ledgerKeeps(
  q: Queryable,
  remote: string,
  path: string,
  id: string,
): Promise<boolean> {
  const { rows } = await q.execute<{ kept: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM original_copies
       WHERE remote = ${remote}
         AND (normalize(path, NFC) = normalize(${path}, NFC) OR object_ref = ${id})) AS kept`)
  return rows[0]?.kept !== false
}

interface Plan {
  canonical: CloudObject[]
  pairs: Pair[]
  skipped: { entry: CloudObject; why: SkipReason }[]
}

/** Which file of the folder is canonical, which is a pair and why the rest is neither. */
function plan(
  entries: readonly CloudObject[],
  folder: string,
  modelId: string,
  paths: readonly string[],
  revisions: ReadonlyMap<string, Revision>,
  ledger: readonly LedgerRow[],
): Plan {
  const canonicalKeys = new Set(paths)
  const index = new LocalPathIndex(paths)
  const prefix = `${nfc(folder)}/`
  const ledgerByKey = new Map<string, LedgerRow[]>()
  const ledgerNodes = new Set<string>()
  for (const row of ledger) {
    const key = nfc(row.path)
    ledgerByKey.set(key, [...(ledgerByKey.get(key) ?? []), row])
    if (row.object_ref) ledgerNodes.add(row.object_ref)
  }
  const times = new Map<string, number>()
  const byKey = new Map<string, CloudObject>()
  for (const entry of entries) {
    const key = nfc(entry.path)
    times.set(key, (times.get(key) ?? 0) + 1)
    byKey.set(key, entry)
  }
  const out: Plan = { canonical: [], pairs: [], skipped: [] }
  const skip = (entry: CloudObject, why: SkipReason) => out.skipped.push({ entry, why })
  for (const entry of entries) {
    const key = nfc(entry.path)
    if (canonicalKeys.has(key) || ledgerByKey.has(`${prefix}${key}`)) {
      out.canonical.push(entry)
      continue
    }
    if ((times.get(key) ?? 0) > 1) {
      skip(entry, 'listed_twice')
      continue
    }
    const apis = index.apiPathsOf(entry.path)
    const [api] = apis
    if (api === undefined) {
      skip(entry, 'unexplained')
      continue
    }
    if (apis.length > 1) {
      skip(entry, 'ambiguous')
      continue
    }
    const revision = revisions.get(api)
    if (!revision) {
      skip(entry, 'no_revision')
      continue
    }
    if (!revision.md5) {
      skip(entry, 'no_md5')
      continue
    }
    if (entry.size !== revision.size) {
      skip(entry, 'size_differs')
      continue
    }
    const canonical = byKey.get(api)
    if (!canonical) {
      skip(entry, 'no_canonical')
      continue
    }
    if ((times.get(api) ?? 0) > 1) {
      skip(entry, 'canonical_listed_twice')
      continue
    }
    if (canonical.size !== revision.size) {
      skip(entry, 'canonical_size_differs')
      continue
    }
    const row = (ledgerByKey.get(`${prefix}${api}`) ?? []).find(
      (r) => r.model_id === modelId && r.source_revision_id === revision.id,
    )
    if (!row) {
      skip(entry, 'canonical_not_in_ledger')
      continue
    }
    const duplicateId = entry.id
    const canonicalId = canonical.id
    if (!duplicateId || !canonicalId) {
      skip(entry, 'no_node_id')
      continue
    }
    if (ledgerNodes.has(duplicateId)) {
      skip(entry, 'ledger_node')
      continue
    }
    out.pairs.push({
      duplicate: { ...entry, id: duplicateId },
      canonical: { ...canonical, id: canonicalId },
      revision,
      row,
      checked:
        row.verified &&
        !row.missing &&
        row.object_ref === canonicalId &&
        row.byte_size === canonical.size &&
        (row.seen_md5 === null || row.seen_md5 === revision.md5),
    })
  }
  return out
}

type Streamed =
  | { digests: Digests }
  | { gone: true }
  | { changed: true }
  | { stalled: string }
  | { short: number }

/** The bytes of the node `expected`, the same node before and after the stream. */
async function streamNode(
  transport: OriginalsTransport,
  remote: string,
  path: string,
  expected: CloudObject & { id: string },
  signal: AbortSignal,
  limits: StreamLimits,
  counted: { bytes: number },
): Promise<Streamed> {
  const before = await transport.stat(remote, path, signal)
  if (!before) return { gone: true }
  if (before.id !== expected.id || before.size !== expected.size) return { changed: true }
  const watch = new StreamWatch(expected.size, limits, signal)
  const digests = new DigestSet({ md5: true, contentHash: true })
  let bytes = 0
  try {
    const body = await transport.open(remote, path, watch.signal)
    for await (const chunk of body) {
      digests.update(chunk)
      bytes += chunk.length
      counted.bytes += chunk.length
      watch.tick()
      if (watch.signal.aborted) throw watch.signal.reason
    }
  } catch (error) {
    const stalled = watch.stalled
    if (stalled !== null) return { stalled }
    throw error
  } finally {
    watch.stop()
  }
  if (bytes !== expected.size) return { short: bytes }
  const after = await transport.stat(remote, path, signal)
  if (after?.id !== expected.id || after.size !== expected.size) return { changed: true }
  return { digests: digests.digest() }
}

const refsOf = (revision: Revision) => ({
  ref_md5: revision.md5,
  ref_remote_sha256: revision.remote_sha256,
  ref_sha256: revision.source_sha256,
  ref_dropbox: null,
})

async function runPair(
  db: Db,
  transport: OriginalsTransport,
  remote: string,
  folder: string,
  pair: Pair,
  signal: AbortSignal,
  limits: StreamLimits,
  counted: { bytes: number },
): Promise<Outcome> {
  const refs = refsOf(pair.revision)
  const canonicalPath = joinPath(folder, pair.canonical.path)
  const duplicatePath = joinPath(folder, pair.duplicate.path)
  let verified: Digests | null = null
  const not = (kind: NotDeleted, why: string): Outcome => ({ kind, why, verified })
  try {
    if (!pair.checked) {
      const got = await streamNode(
        transport,
        remote,
        canonicalPath,
        pair.canonical,
        signal,
        limits,
        counted,
      )
      if ('stalled' in got) return not('stalled', `canonical: ${got.stalled}`)
      if ('short' in got) return not('failed', `canonical: the stream ended at ${got.short} bytes`)
      if (!('digests' in got)) return not('canonical_changed', 'the canonical node is not there')
      const why = compare(refs, got.digests)
      if (why !== null) return not('canonical_mismatch', why)
      verified = got.digests
    }
    const got = await streamNode(
      transport,
      remote,
      duplicatePath,
      pair.duplicate,
      signal,
      limits,
      counted,
    )
    if ('gone' in got) return { kind: 'gone', verified }
    if ('changed' in got) return not('node_changed', 'another node under the duplicate’s path')
    if ('stalled' in got) return not('stalled', got.stalled)
    if ('short' in got) return not('failed', `the stream ended at ${got.short} bytes`)
    const why = compare(refs, got.digests)
    if (why !== null) return not('duplicate_mismatch', why)
    const canonical = await transport.stat(remote, canonicalPath, signal)
    if (canonical?.id !== pair.canonical.id || canonical.size !== pair.canonical.size) {
      return not('canonical_changed', 'the canonical node changed')
    }
    if (signal.aborted) return { kind: 'interrupted', verified }
    await transport.removeDuplicate(
      remote,
      duplicatePath,
      {
        id: pair.duplicate.id,
        size: pair.duplicate.size,
        inLedger: (r, p, id) => ledgerKeeps(db, r, p, id),
      },
      signal,
    )
    return { kind: 'deleted', md5: got.digests.md5 as string, verified }
  } catch (error) {
    if (signal.aborted) return { kind: 'interrupted', verified }
    if (error instanceof TransportError && error.code === 'not_found') {
      return { kind: 'gone', verified }
    }
    if (error instanceof TransportError && error.code === 'refused') {
      return not('refused', error.message)
    }
    return not('failed', error instanceof Error ? error.message : String(error))
  }
}

/** The ledger keeps the check of a canonical copy this run streamed. */
async function recordCanonical(db: Db, pair: Pair, digests: Digests): Promise<boolean> {
  const hex = (value: string | null) => sql`decode(${value}, 'hex')`
  const { rowCount } = await db.execute(sql`
    UPDATE original_copies
       SET verified_at = now(), verified_by = ${DEDUPE_BY},
           object_ref = ${pair.canonical.id}, byte_size = ${pair.canonical.size},
           seen_md5 = ${hex(digests.md5)}, seen_sha256 = ${hex(digests.sha256)},
           seen_dropbox_hash = ${hex(digests.contentHash)},
           last_seen_at = now(), unseen_since = NULL, error = NULL, next_try_at = NULL
     WHERE model_id = ${pair.row.model_id}::uuid AND id = ${pair.row.id}::uuid
       AND verified_at IS NULL`)
  return (rowCount ?? 0) > 0
}

export async function megaDedupe(db: Db, options: DedupeOptions): Promise<DedupeReport> {
  const { transport } = options
  const { models } = await configuredModels(db, { all: true })
  const model = models.find((m) => m.code === options.model)
  if (!model) {
    throw new Error(`${options.model}: no such model with a valid originals.model_config`)
  }
  const { mega } = model.config
  const sub = model.config.copies.yandex_disk
  if (!mega || !sub) {
    throw new Error(
      `${options.model}: originals.model_config has no «mega» and «copies.yandex_disk»`,
    )
  }
  const remote = mega.remote
  const folder = joinPath(mega.path, sub)
  const signal = options.signal ?? new AbortController().signal

  await transport.flush(signal)
  const entries = await transport.list(remote, folder, signal)
  const [paths, revisions, ledger] = [
    await yandexPaths(db, model.id),
    await revisionsByPath(db, model.id),
    await ledgerOf(db, remote),
  ]
  const planned = plan(entries, folder, model.id, paths, revisions, ledger)

  const report: DedupeReport = {
    model: model.code,
    written: options.write,
    folder: remoteText({ remote, path: folder }),
    listed: size(0, 0),
    canonical: size(0, 0),
    pairs: {
      ...size(0, 0),
      canonical_checked: 0,
      canonical_to_check: size(0, 0),
      download: size(0, 0),
    },
    skipped: {},
  }
  for (const entry of entries) add(report.listed, entry.size)
  for (const entry of planned.canonical) add(report.canonical, entry.size)
  for (const { entry, why } of planned.skipped) {
    const into = report.skipped[why] ?? size(0, 0)
    add(into, entry.size)
    report.skipped[why] = into
  }
  for (const pair of planned.pairs) {
    add(report.pairs, pair.duplicate.size)
    add(report.pairs.download, pair.duplicate.size)
    if (pair.checked) {
      report.pairs.canonical_checked += 1
    } else {
      add(report.pairs.canonical_to_check, pair.canonical.size)
      add(report.pairs.download, pair.canonical.size)
    }
  }
  const listed = new Map<Pair, string>()
  const finish = () => {
    if (options.list) {
      report.list = {
        pairs: planned.pairs.map((pair) => ({
          duplicate: pair.duplicate.path,
          canonical: pair.canonical.path,
          bytes: pair.duplicate.size,
          ...(listed.has(pair) ? { outcome: listed.get(pair) } : {}),
        })),
        skipped: planned.skipped.map(({ entry, why }) => ({
          path: entry.path,
          bytes: entry.size,
          why,
        })),
      }
    }
    return report
  }
  if (!options.write) return finish()

  const streams = Math.max(1, Math.floor(options.streams ?? DEFAULT_STREAMS))
  const limits: StreamLimits = {
    idleMs: options.idleMs ?? DEFAULT_LIMITS.idleMs,
    baseMs: options.baseMs ?? DEFAULT_LIMITS.baseMs,
    minBytesPerSec: options.minBytesPerSec ?? DEFAULT_LIMITS.minBytesPerSec,
  }
  const stallsToStop = options.stallsToStop ?? Math.max(2, streams)
  const deleted = size(0, 0)
  const notDeleted: Partial<Record<NotDeleted, number>> = {}
  const removed: { path: string; node: string; bytes: number; md5: string }[] = []
  const left: { path: string; why: string }[] = []
  let gone = 0
  let verifiedNow = 0
  let done = 0
  let stallsInRow = 0
  const counted = { bytes: 0 }
  report.streams = streams
  report.stopped = 'done'
  options.progress?.(
    `mega-dedupe: ${planned.pairs.length} pairs, ${gib(report.pairs.bytes)} GiB of duplicates; ` +
      `${report.pairs.canonical_to_check.files} canonical copies to check ` +
      `(${gib(report.pairs.canonical_to_check.bytes)} GiB)`,
  )
  const queue = [...planned.pairs].sort(
    (a, b) =>
      Number(b.checked) - Number(a.checked) || a.duplicate.path.localeCompare(b.duplicate.path),
  )
  try {
    const stopped = await lanes(queue, {
      streams,
      signal,
      stop: () => (stallsInRow >= stallsToStop ? 'stalled' : null),
      run: (pair) => runPair(db, transport, remote, folder, pair, signal, limits, counted),
      done: async (pair, outcome) => {
        if (outcome.verified && (await recordCanonical(db, pair, outcome.verified))) {
          verifiedNow += 1
        }
        if (outcome.kind === 'interrupted') return
        done += 1
        listed.set(pair, outcome.kind)
        if (outcome.kind === 'deleted') {
          add(deleted, pair.duplicate.size)
          removed.push({
            path: joinPath(folder, pair.duplicate.path),
            node: pair.duplicate.id,
            bytes: pair.duplicate.size,
            md5: outcome.md5,
          })
        } else if (outcome.kind === 'gone') {
          gone += 1
        } else {
          notDeleted[outcome.kind] = (notDeleted[outcome.kind] ?? 0) + 1
          left.push({ path: joinPath(folder, pair.duplicate.path), why: outcome.why })
        }
        stallsInRow = outcome.kind === 'stalled' ? stallsInRow + 1 : 0
        const missed = Object.values(notDeleted).reduce((sum, n) => sum + n, 0)
        options.progress?.(
          `mega-dedupe: ${done} / ${queue.length} pairs, deleted ${deleted.files} ` +
            `(${gib(deleted.bytes)} GiB), not deleted ${missed}, downloaded ${gib(counted.bytes)} GiB`,
        )
      },
    })
    if (stopped === 'stalled') report.stopped = 'stalled'
  } catch (error) {
    if (!signal.aborted) throw error
    report.stopped = 'interrupted'
  } finally {
    report.deleted = deleted
    report.gone = gone
    report.not_deleted = notDeleted
    report.canonical_verified = verifiedNow
    report.downloaded = { bytes: counted.bytes, gib: size(0, counted.bytes).gib }
    await withActorTx(
      db,
      { actor: SYSTEM_ACTOR('ops'), action: 'originals.mega_dedupe', requestId: randomUUID() },
      async (tx) => {
        await logAction(tx, {
          modelId: model.id,
          subjectKind: 'original_copies',
          subjectLabel: `Дубли MEGA: ${model.code}`,
          after: {
            folder: report.folder,
            pairs: report.pairs,
            skipped: report.skipped,
            deleted,
            gone,
            not_deleted: notDeleted,
            canonical_verified: verifiedNow,
            downloaded_bytes: counted.bytes,
            stopped: report.stopped,
            removed,
            left,
          },
        })
      },
    )
  }
  return finish()
}
