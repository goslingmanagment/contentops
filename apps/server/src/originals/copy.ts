import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type Queryable, WorkError, type WorkHandler } from '@contentops/db'
import { DigestSet, sourcePath } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { readNotContent } from '../legacy/inputs'
import type { BlobStore } from '../media/storage'
import { CHECKED_BY, compare, hasReference, ordered, RETRY_MS } from './check'
import {
  type ConfiguredModel,
  configuredModels,
  joinPath,
  listsFolder,
  type OriginKind,
  pathKey,
} from './config'
import { addEnrol, emptyEnrol, enrolOriginals } from './enrol'
import { DEFAULT_LIMITS, DEFAULT_STREAMS, lanes, type StreamLimits, StreamWatch } from './streams'
import {
  type CloudObject,
  MEGA_ROOT,
  type OriginalsTransport,
  PART_SUFFIX,
  TransportError,
  type UploadSource,
  WRITE_ROOTS,
} from './transport'

/**
 * Work `originals_copy` of role `worker`, slot `originals` (SPEC §9.4): ContentOps writes the
 * copies of the originals itself. Every 10 minutes a run of at most 30 minutes goes over the copy
 * rows that have no object yet (`enrol.ts` makes them: the MEGA copies of `copies`, the Dropbox
 * copies of `dropbox_copies`, both copies of every web upload), `ORIGINALS_STREAMS` at a time:
 * bytes already on our disk first, then what frees the PC, then the rest. Per row:
 *
 * 1. the folder: MEGA — inside the model's MEGA folder, under `originals/`; Dropbox — one of the
 *    folders ContentOps writes there (`Архив Я.Диска`, `Загрузки ContentOps`), and only while it
 *    is in `exclude` of the model's `originals.model_config` and in its
 *    `legacy.not_content.dropbox` — otherwise the run writes nothing there and says so
 *    (`refused`): the owner sets the policy, not the code;
 * 2. what lies at the path: a file of the original's size — taken (its node), the check reads its
 *    bytes; another file — moved aside to `Копии/заменённые <ГГГГ-ММ-ДД>/<path>` in the same
 *    folder, never overwritten (rows that pointed at it follow it there). A copy whose bytes the
 *    check found wrong is moved aside the same way and written again, once; one whose node the
 *    check no longer finds is written again;
 * 3. the bytes: the staged source in the VM when it is still there, a web upload's blob, else the
 *    model's own cloud through rclone (cloud to cloud, nothing on our disk);
 * 4. the write (`transport.upload`) to `<path>.co-part`: every byte rclone reads is hashed here
 *    (MD5, SHA-256, Dropbox) and the last piece is held back until the whole matches the
 *    original's hashes, so wrong bytes never complete an upload; then the cloud's own answer — the
 *    size, and in Dropbox its `content_hash` — must be of the bytes streamed, or the part goes
 *    (MEGA: deleted, it is ours; Dropbox: moved to `Копии/неверные <ГГГГ-ММ-ДД>/`, nothing is
 *    deleted in Dropbox); then the part is moved into place.
 *
 * Such a copy is checked by the write itself: `verified_at`, `verified_by = 'worker:originals'`,
 * the hashes of the very bytes it streamed (they matched the original) and the node or Dropbox ID
 * the cloud gave back for them. That is the byte check of that place (SPEC §9.4); later the
 * nightly audit keeps it only while the same node (and in Dropbox the same hash) lies there.
 */

export const COPY_INTERVAL_MS = 10 * 60_000
export const copyStreamKey = 'originals-copy'

export interface CopyOptions extends Partial<StreamLimits> {
  /** The clouds; `null` — no rclone configuration: the work fails at once and says so. */
  transport: () => OriginalsTransport | null
  /** Our disk: staged sources and blobs; null — only cloud to cloud. */
  store: BlobStore | null
  /** How long one run starts new writes; default 30 min. */
  budgetMs?: number
  /** `ORIGINALS_STREAMS`: writes at once; default 8. */
  streams?: number
  /** Stalls in a row that end the run; default the number of streams, at least 2. */
  stallsToStop?: number
  /** The day of `Копии/… <ГГГГ-ММ-ДД>`; the tests fix it. */
  now?: () => Date
}

export interface CopyReport {
  due: number
  /** Written by this run and checked by their own stream. */
  copied: number
  copied_bytes: number
  /** Found at the path with the original's size: the check reads their bytes. */
  taken: number
  /** Another file lay at the path: moved to `Копии/заменённые …`. */
  moved_aside: number
  /** The original's own source gives other bytes than its hashes: nothing written. */
  source_mismatch: number
  /** The cloud stored other bytes than streamed: the part went. */
  stored_wrong: number
  /** No bytes to copy from: not on our disk, the source file gone or replaced. */
  no_source: number
  stalled: number
  failed: number
  /** Rows not written because their folder is not allowed for the model (below). */
  held: number
  refused: { model: string; place: 'mega' | 'dropbox'; folder: string; why: string }[]
  sources: { staging: number; blob: number; cloud: number }
  streams: number
  stopped: 'done' | 'budget' | 'stalled'
  enrolled: ReturnType<typeof emptyEnrol>
}

interface Row extends Record<string, unknown> {
  model_id: string
  id: string
  source_revision_id: string | null
  web_upload_id: string | null
  place: 'mega' | 'dropbox'
  remote: string
  path: string
  object_ref: string | null
  original_size: string
  ref_md5: string | null
  ref_remote_sha256: string | null
  ref_sha256: string | null
  ref_dropbox: string | null
  source_kind: OriginKind | null
  current_path: string | null
  root_path: string | null
  live: boolean
  staged_sha: string | null
  blob_key: string | null
}

type Seen = { md5: string | null; sha256: string; contentHash: string | null }
type SourceKind = 'staging' | 'blob' | 'cloud'

type Outcome =
  | { kind: 'copied'; node: CloudObject; digests: Seen; source: SourceKind }
  | { kind: 'taken'; node: CloudObject }
  | { kind: 'source_mismatch'; why: string }
  | { kind: 'stored_wrong'; why: string }
  | { kind: 'no_source'; why: string }
  | { kind: 'stalled'; why: string }
  | { kind: 'failed'; why: string }
  | { kind: 'held' }

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const NO_SOURCE_MS = 7 * DAY

/** The rows to write: no object yet, or bytes the check found wrong (written again once). */
async function dueRows(q: Queryable, models: readonly string[]): Promise<Row[]> {
  const { rows } = await q.execute<Row>(sql`
    SELECT c.model_id, c.id, c.source_revision_id, c.web_upload_id, c.place, c.remote, c.path,
           c.object_ref, COALESCE(r.byte_size, u.size_expected)::text AS original_size,
           encode(r.md5, 'hex') AS ref_md5, encode(r.remote_sha256, 'hex') AS ref_remote_sha256,
           encode(COALESCE(r.source_sha256, u.sha256), 'hex') AS ref_sha256,
           encode(r.content_hash, 'hex') AS ref_dropbox,
           s.kind AS source_kind, o.current_path, s.root_path,
           COALESCE(o.current_revision_id = r.id AND o.gone_since IS NULL, false) AS live,
           encode(r.source_sha256, 'hex') AS staged_sha, b.storage_key AS blob_key
      FROM original_copies c
      LEFT JOIN source_revisions r ON r.model_id = c.model_id AND r.id = c.source_revision_id
      LEFT JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      LEFT JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
      LEFT JOIN web_uploads u ON u.model_id = c.model_id AND u.id = c.web_upload_id
      LEFT JOIN blobs b ON b.sha256 = u.sha256 AND b.state = 'present'
     WHERE c.model_id = ANY (${sql.param([...models])}::uuid[])
       AND c.role = 'copy' AND c.remote IS NOT NULL AND c.place IN ('mega', 'dropbox')
       AND c.verified_at IS NULL AND c.missing_since IS NULL
       AND ((c.object_ref IS NULL AND (c.next_try_at IS NULL OR c.next_try_at <= now()))
            -- The check found nothing under the path, or bytes that are not the original's.
            OR c.error LIKE 'absent:%'
            OR (c.error LIKE 'mismatch:%' AND c.error NOT LIKE 'mismatch: copy:%'))
     ORDER BY c.path, c.id`)
  return rows
}

/** `ГГГГ-ММ-ДД` in Moscow. */
function moscowDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(at)
}

interface ModelPolicy {
  model: ConfiguredModel
  /** Why a write into this folder is refused; null — allowed. */
  refuse: (row: Row) => { folder: string; why: string } | null
  /** The folder whose `Копии/` takes what is moved aside, and the rest of the path. */
  base: (row: Row) => { base: string; rest: string } | null
}

async function policyOf(q: Queryable, model: ConfiguredModel): Promise<ModelPolicy> {
  const notContent = await readNotContent(q, model.id, 'dropbox')
  const { mega, dropbox, exclude } = model.config
  const base = (row: Row) => {
    if (row.place === 'mega') {
      if (!mega || row.remote !== mega.remote) return null
      if (!pathKey(row.path, 'mega').startsWith(`${pathKey(mega.path, 'mega')}/`)) return null
      return { base: mega.path, rest: row.path.slice(mega.path.length + 1) }
    }
    const at = row.path.indexOf('/')
    if (!dropbox || row.remote !== dropbox.remote || at <= 0) return null
    return { base: row.path.slice(0, at), rest: row.path.slice(at + 1) }
  }
  const refuse = (row: Row) => {
    const where = base(row)
    if (row.place === 'mega') {
      const folder = row.path.split('/').slice(0, 2).join('/')
      if (!where) return { folder, why: 'not in the model’s MEGA folder' }
      if (!pathKey(where.base, 'mega').startsWith(`${MEGA_ROOT}/`)) {
        return { folder, why: `the model’s MEGA folder is not under ${MEGA_ROOT}/` }
      }
      return null
    }
    const folder = where?.base ?? row.path.split('/')[0] ?? row.path
    if (!where) return { folder, why: 'not in the model’s Dropbox' }
    if (
      !(WRITE_ROOTS.dropbox ?? []).some(
        (root) => pathKey(root, 'dropbox') === pathKey(folder, 'dropbox'),
      )
    ) {
      return { folder, why: 'not a folder ContentOps writes in Dropbox' }
    }
    if (!listsFolder(exclude.dropbox, folder)) {
      return { folder, why: 'not in exclude.dropbox of originals.model_config' }
    }
    if (!listsFolder(notContent, folder)) {
      return { folder, why: 'not in legacy.not_content.dropbox' }
    }
    return null
  }
  return { model, refuse, base }
}

/** The staged sources on our disk by their SHA-256. */
async function stagedFiles(store: BlobStore | null): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!store) return out
  let names: string[]
  try {
    names = await readdir(store.stagingDir)
  } catch {
    return out
  }
  for (const name of names) {
    const sha = name.split('.')[0] ?? ''
    if (/^[0-9a-f]{64}$/u.test(sha) && !name.includes('.part'))
      out.set(sha, join(store.stagingDir, name))
  }
  return out
}

type Opener = (signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>

async function localFile(path: string, size: number): Promise<Opener | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size !== size) return null
  return async (signal) => createReadStream(path, { signal, highWaterMark: 1 << 20 })
}

/** Where the bytes come from: our disk first, the model's cloud otherwise. */
async function sourceOf(
  row: Row,
  model: ConfiguredModel,
  store: BlobStore | null,
  staged: Map<string, string>,
  transport: OriginalsTransport,
): Promise<{ kind: SourceKind; open: Opener } | { why: string }> {
  const size = Number(row.original_size)
  if (row.web_upload_id) {
    if (!store || !row.blob_key) return { why: 'the upload’s bytes are not on our disk' }
    const open = await localFile(store.path(row.blob_key), size)
    return open ? { kind: 'blob', open } : { why: 'the upload’s blob is not on our disk' }
  }
  const local = row.staged_sha ? staged.get(row.staged_sha) : undefined
  if (local) {
    const open = await localFile(local, size)
    if (open) return { kind: 'staging', open }
  }
  if (!row.live || !row.source_kind || !row.current_path) {
    return { why: 'the source file is gone or has a newer revision' }
  }
  const ref = model.config[row.source_kind]
  if (!ref) return { why: `no ${row.source_kind} remote in originals.model_config` }
  const relative = sourcePath(row.current_path, row.root_path ?? '').relative
  const inside =
    ref.path === '' ||
    pathKey(relative, row.source_kind).startsWith(`${pathKey(ref.path, row.source_kind)}/`)
  if (relative === '' || !inside) return { why: 'the source file is outside its remote' }
  return { kind: 'cloud', open: (signal) => transport.open(ref.remote, relative, signal) }
}

/**
 * The bytes of one write as rclone reads them: hashed as they pass, the last piece held back
 * until the whole matched the original. A read that does not match ends with an error, so the
 * upload never completes; every later read is refused.
 */
class CheckedSource {
  readonly watch: StreamWatch
  /** The hashes of the last read that went to its end and matched. */
  accepted: Seen | null = null
  /** Why the source's bytes are not the original's. */
  rejected: string | null = null
  readonly source: UploadSource
  readonly #size: number
  readonly #row: Row

  constructor(row: Row, open: Opener, limits: StreamLimits, parent: AbortSignal) {
    this.#row = row
    this.#size = Number(row.original_size)
    this.watch = new StreamWatch(this.#size, limits, parent)
    this.source = {
      size: this.#size,
      open: async (signal) => {
        if (this.rejected) throw new Error(`the source gives other bytes: ${this.rejected}`)
        const both = AbortSignal.any([signal, this.watch.signal])
        return this.#checked(await open(both), both)
      },
    }
  }

  async *#checked(body: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const digests = new DigestSet({ md5: true, contentHash: true })
    let held: Uint8Array | null = null
    let bytes = 0
    for await (const chunk of body) {
      if (signal.aborted) throw signal.reason
      digests.update(chunk)
      bytes += chunk.length
      this.watch.tick()
      if (held) yield held
      held = chunk
    }
    const got = digests.digest()
    const why = bytes !== this.#size ? `${bytes} of ${this.#size} bytes` : compare(this.#row, got)
    if (why !== null) {
      this.rejected = why
      throw new Error(`the source gives other bytes: ${why}`)
    }
    this.accepted = got
    if (held) yield held
  }
}

interface Run {
  q: Queryable
  transport: OriginalsTransport
  store: BlobStore | null
  staged: Map<string, string>
  policies: Map<string, ModelPolicy>
  limits: StreamLimits
  signal: AbortSignal
  day: string
  report: CopyReport
}

const message = (error: unknown) =>
  error instanceof TransportError || error instanceof Error ? error.message : String(error)

/**
 * Moves what lies at `path` to `<base>/Копии/<label> <day>/<rest>` (a free name), never over
 * anything; the rows of the ledger that pointed at that node follow it there.
 */
async function moveAside(
  run: Run,
  row: Row,
  path: string,
  node: CloudObject,
  label: 'заменённые' | 'неверные',
): Promise<string> {
  const where = run.policies.get(row.model_id)?.base({ ...row, path })
  if (!where) throw new TransportError('refused', `${path}: no folder to move it aside in`)
  for (let n = 1; n <= 9; n += 1) {
    const folder = `${label} ${run.day}${n === 1 ? '' : ` (${n})`}`
    const aside = joinPath(where.base, 'Копии', folder, where.rest)
    try {
      await run.transport.move(row.remote, path, aside, run.signal)
    } catch (error) {
      if (error instanceof TransportError && error.code === 'exists') continue
      throw error
    }
    if (node.id) {
      await run.q.execute(sql`
        UPDATE original_copies SET path = ${aside}
         WHERE remote = ${row.remote} AND path = ${path} AND object_ref = ${node.id}
           AND NOT (model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid)`)
    }
    return aside
  }
  throw new TransportError('failed', `${path}: no free name in Копии/${label} ${run.day}`)
}

/** Our part is not to stay: deleted in MEGA, moved aside in Dropbox. */
async function dropPart(run: Run, row: Row, part: string, node: CloudObject): Promise<void> {
  if (row.place === 'mega') await run.transport.removePart(row.remote, part, run.signal)
  else await moveAside(run, row, part, node, 'неверные')
}

async function copyOne(run: Run, row: Row): Promise<Outcome> {
  const policy = run.policies.get(row.model_id)
  if (!policy) return { kind: 'failed', why: 'the model is not configured' }
  if (policy.refuse(row)) return { kind: 'held' }
  const size = Number(row.original_size)
  if (!hasReference(row)) return { kind: 'no_source', why: 'the original has no hash to check' }
  const { transport, signal } = run

  // 1. What lies at the path now.
  const there = await transport.stat(row.remote, row.path, signal)
  if (there) {
    const known = row.object_ref !== null && there.id === row.object_ref
    if (!known && there.size === size) return { kind: 'taken', node: there }
    await moveAside(run, row, row.path, there, 'заменённые')
    run.report.moved_aside += 1
  }
  if (row.object_ref !== null) {
    // The node the row knew is not at the path any more: the row waits for the new one.
    await run.q.execute(sql`
      UPDATE original_copies SET object_ref = NULL, byte_size = NULL, copied_at = NULL
       WHERE model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid AND verified_at IS NULL`)
  }
  const part = `${row.path}${PART_SUFFIX}`
  const leftover = await transport.stat(row.remote, part, signal)
  if (leftover) await dropPart(run, row, part, leftover)

  // 2. The bytes.
  const from = await sourceOf(row, policy.model, run.store, run.staged, transport)
  if ('why' in from) return { kind: 'no_source', why: from.why }

  // 3. The write, hashed as it goes.
  const checked = new CheckedSource(row, from.open, run.limits, signal)
  let object: CloudObject
  try {
    object = await transport.upload(row.remote, part, checked.source, checked.watch.signal)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    const stray = await transport.stat(row.remote, part, signal).catch(() => null)
    if (stray) await dropPart(run, row, part, stray).catch(() => {})
    if (checked.rejected) return { kind: 'source_mismatch', why: checked.rejected }
    const stalled = checked.watch.stalled
    if (stalled !== null) return { kind: 'stalled', why: stalled }
    return { kind: 'failed', why: message(error) }
  } finally {
    checked.watch.stop()
  }
  const seen = checked.accepted
  const wrong =
    seen === null
      ? 'rclone did not read the bytes'
      : !object.id
        ? 'the cloud gives no ID'
        : object.size !== size
          ? `the cloud stored ${object.size} of ${size} bytes`
          : row.place === 'dropbox' && object.dropbox !== seen.contentHash
            ? 'the Dropbox hash is not of the bytes streamed'
            : null
  if (wrong !== null || seen === null) {
    await dropPart(run, row, part, object)
    return { kind: 'stored_wrong', why: wrong ?? 'no bytes' }
  }

  // 4. Into place: the very object that was checked.
  const placed = await transport.move(row.remote, part, row.path, signal)
  if (
    placed.id !== object.id ||
    placed.size !== size ||
    (row.place === 'dropbox' && placed.dropbox !== object.dropbox)
  ) {
    return { kind: 'failed', why: 'the moved file is not the one written' }
  }
  return { kind: 'copied', node: placed, digests: seen, source: from.kind }
}

const ms = (value: number) => sql`${value}::bigint * interval '1 millisecond'`
const bytea = (hex: string | null) => sql`decode(${hex}, 'hex')`

async function record(q: Queryable, row: Row, outcome: Outcome): Promise<void> {
  const where = sql`model_id = ${row.model_id}::uuid AND id = ${row.id}::uuid
    AND verified_at IS NULL`
  const failure = async (error: string, retryMs: number, count: boolean) => {
    await q.execute(sql`
      UPDATE original_copies
         SET error = ${error.slice(0, 2000)}, attempts = attempts + ${count ? 1 : 0},
             next_try_at = now() + ${ms(retryMs)}
       WHERE ${where}`)
  }
  switch (outcome.kind) {
    case 'copied':
      await q.execute(sql`
        UPDATE original_copies
           SET object_ref = ${outcome.node.id}, byte_size = ${outcome.node.size},
               copied_at = now(), verified_at = now(), verified_by = ${CHECKED_BY},
               seen_md5 = ${bytea(outcome.digests.md5)},
               seen_sha256 = ${bytea(outcome.digests.sha256)},
               seen_dropbox_hash = ${bytea(outcome.digests.contentHash)},
               last_seen_at = now(), unseen_since = NULL, error = NULL, next_try_at = NULL
         WHERE ${where}`)
      return
    case 'taken':
      await q.execute(sql`
        UPDATE original_copies
           SET object_ref = ${outcome.node.id}, byte_size = ${outcome.node.size},
               copied_at = COALESCE(copied_at, ${outcome.node.modTime}::timestamptz, now()),
               last_seen_at = now(), unseen_since = NULL, error = NULL, next_try_at = NULL
         WHERE ${where}`)
      return
    case 'source_mismatch':
      return failure(
        `mismatch: copy: the source gives other bytes (${outcome.why})`,
        RETRY_MS.mismatch,
        true,
      )
    case 'stored_wrong':
      return failure(`failed: copy: ${outcome.why}`, RETRY_MS.failed, true)
    case 'no_source':
      return failure(`no_source: ${outcome.why}`, NO_SOURCE_MS, false)
    case 'stalled':
      return failure(`timeout: copy: ${outcome.why}`, RETRY_MS.stalled, true)
    case 'failed':
      return failure(`failed: copy: ${outcome.why}`, RETRY_MS.failed, true)
    case 'held':
      return
  }
}

export function originalsCopyHandler(options: CopyOptions): WorkHandler {
  const streams = Math.max(1, Math.floor(options.streams ?? DEFAULT_STREAMS))
  const settings = {
    budgetMs: options.budgetMs ?? 30 * MINUTE,
    stallsToStop: options.stallsToStop ?? Math.max(2, streams),
    limits: {
      idleMs: options.idleMs ?? DEFAULT_LIMITS.idleMs,
      baseMs: options.baseMs ?? DEFAULT_LIMITS.baseMs,
      minBytesPerSec: options.minBytesPerSec ?? DEFAULT_LIMITS.minBytesPerSec,
    },
  }
  return async ({ db, signal, checkpoint }) => {
    const transport = options.transport()
    if (!transport) {
      throw new WorkError('permanent', 'not_configured', 'RCLONE_CONFIG is not set or not there')
    }
    const started = Date.now()
    const { models } = await configuredModels(db)
    const enrolled = emptyEnrol()
    for (const model of models) addEnrol(enrolled, await enrolOriginals(db, model))
    const report: CopyReport = {
      due: 0,
      copied: 0,
      copied_bytes: 0,
      taken: 0,
      moved_aside: 0,
      source_mismatch: 0,
      stored_wrong: 0,
      no_source: 0,
      stalled: 0,
      failed: 0,
      held: 0,
      refused: [],
      sources: { staging: 0, blob: 0, cloud: 0 },
      streams,
      stopped: 'done',
      enrolled,
    }
    const due = await dueRows(
      db,
      models.map((model) => model.id),
    )
    report.due = due.length
    if (due.length === 0) return { report }
    const policies = new Map<string, ModelPolicy>()
    for (const model of models) policies.set(model.id, await policyOf(db, model))
    const refusals = new Map<string, CopyReport['refused'][number]>()
    for (const row of due) {
      const policy = policies.get(row.model_id)
      const refused = policy?.refuse(row)
      if (!policy || !refused) continue
      const key = `${policy.model.code}\u0000${row.place}\u0000${refused.folder}\u0000${refused.why}`
      if (!refusals.has(key)) {
        refusals.set(key, { model: policy.model.code, place: row.place, ...refused })
      }
    }
    report.refused = [...refusals.values()]
    const staged = await stagedFiles(options.store)
    const run: Run = {
      q: db,
      transport,
      store: options.store,
      staged,
      policies,
      limits: settings.limits,
      signal,
      day: moscowDay(options.now?.() ?? new Date()),
      report,
    }
    // Bytes on our disk go first: they are the cheapest and the first to be needed back.
    const local = (row: Row) =>
      row.web_upload_id !== null || (row.staged_sha !== null && staged.has(row.staged_sha))
    const allowed = due.filter((row) => !policies.get(row.model_id)?.refuse(row))
    report.held = due.length - allowed.length
    const queue = await ordered(db, models, allowed, local)
    let stallsInRow = 0
    let done = 0
    const stopped = await lanes(queue, {
      streams,
      signal,
      stop: () => {
        if (stallsInRow >= settings.stallsToStop) return 'stalled'
        return Date.now() - started >= settings.budgetMs ? 'budget' : null
      },
      run: async (row): Promise<Outcome> => {
        try {
          return await copyOne(run, row)
        } catch (error) {
          if (signal.aborted) throw signal.reason
          return { kind: 'failed', why: message(error) }
        }
      },
      done: async (row, outcome) => {
        await record(db, row, outcome)
        done += 1
        switch (outcome.kind) {
          case 'copied':
            report.copied += 1
            report.copied_bytes += outcome.node.size
            report.sources[outcome.source] += 1
            break
          case 'taken':
            report.taken += 1
            break
          case 'held':
            report.held += 1
            break
          default:
            report[outcome.kind] += 1
        }
        if (outcome.kind !== 'held') stallsInRow = outcome.kind === 'stalled' ? stallsInRow + 1 : 0
        await checkpoint({
          progress: {
            num: done,
            den: queue.length,
            note: `скопировано ${report.copied}, найдено на месте ${report.taken}`,
          },
        })
      },
    })
    if (stopped === 'stalled' || stopped === 'budget') report.stopped = stopped
    return { report }
  }
}
