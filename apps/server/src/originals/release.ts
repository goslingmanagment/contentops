import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  OriginalsRelease,
  ReleaseBlock,
  ReleaseFile,
  ReleaseHolder,
} from '@contentops/contracts/domain/originals'
import { isSwitchOn, type Queryable } from '@contentops/db'
import {
  apiToLocalPath,
  COPY_LIST_FILE,
  type CopyListEntry,
  LocalPathIndex,
  parseCopyList,
  relativePath,
} from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { originalsRule } from './rule'

/**
 * What the PC may free now (SPEC §9.4, §12.2; ops/README.md «Оригиналы: два места»): the route
 * `admin.originalsRelease` for the Windows task of a holder (`ops/winpc/ContentOps-Originals.ps1`).
 * The truth about the PC is its fresh list in the host share — there is no report by API:
 *
 * - `ydisk_copy` — the copy of Я.Диск on C:, Lora's: `ydisk-copy-list.jsonl` (`ContentOps-CopyList`);
 *   a revision of Я.Диск the rule releases whose file in the copy has its bytes on disk with the
 *   revision's size. The PC sets UNPINNED and the Я.Диск client takes the bytes off C:.
 * - `e_ari` — Ari's archive `E:\Ari`, the mirror of the root of her Dropbox:
 *   `ari-copy-list.jsonl` (the task itself writes it, same shape); a revision of Dropbox the rule
 *   releases whose file in `E:\Ari` has its size and has not changed for 24 h, inside a type
 *   root and never under `_опись`. The PC deletes it only if the Dropbox hash of its bytes is the revision's.
 *
 * Only the current revision of a live object is given out: the file on the PC is that one. Nothing
 * is given while the owner's switch `originals.enabled` is off, the list is older than 30 min, its
 * walk had errors or ran beside the Я.Диск client, or the copy's release session runs
 * (`originals-host.json`). A batch is at most `originals.release_batch` (200 files, 50 GB); until
 * the PC has freed anything of the holder (its own count in its report) — the first batch, 50 files.
 * It only reads.
 */

/** The model whose files the holder keeps: the PC holds Lora's Я.Диск and Ari's archive. */
export const HOLDER_MODEL: Readonly<Record<ReleaseHolder, string>> = {
  ydisk_copy: 'lora',
  e_ari: 'ari',
}

/** The list of `E:\Ari` in the host share, the same shape as the copy list of Я.Диск. */
export const ARI_LIST_FILE = 'ari-copy-list.jsonl'
/** The copy's release session as the PC reports it. */
export const HOST_REPORT_FILE = 'originals-host.json'

export const HOST_AGENT_KEY = 'originals.host_agent'
export const BATCH_KEY = 'originals.release_batch'
/** The owner's switch of the originals (`ops.js originals on|off`). */
export const ORIGINALS_SWITCH = 'originals.enabled'

/** A list older than this is not the PC now (the task refreshes it right before it asks). */
export const LIST_FRESH_MS = 30 * 60_000
/** A file of `E:\Ari` changed within this may still be travelling to Dropbox. */
export const ARI_UNCHANGED_MS = 24 * 3600_000

export const DEFAULT_BATCH = { files: 200, bytes: 50_000_000_000, first_files: 50 }
export type BatchLimits = typeof DEFAULT_BATCH

const ARI_INVENTORY = '_опись'
const YDISK_SERVICE = '.sync'

export interface ListMeta {
  finished_at: string | null
  errors: number
  client_running: boolean
  /** `E:\Ari`: files the PC has deleted so far by this route. */
  removed_total: number
}

/** `ydisk-copy-list.jsonl` → `ydisk-copy-list.meta.json`. */
export function metaFileOf(listFile: string): string {
  return listFile.replace(/\.jsonl$/iu, '.meta.json')
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

/** The PC writes UTF-8, sometimes with a BOM (Windows PowerShell 5.1). */
async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, ''))
}

export function parseListMeta(raw: unknown): ListMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const meta = raw as Record<string, unknown>
  return {
    finished_at: typeof meta.finished_at === 'string' ? meta.finished_at : null,
    errors: num(meta.errors),
    client_running: meta.client_running === true,
    removed_total: num(meta.removed_total),
  }
}

/** The PC's release session of the copy: `running` while the client takes the bytes off. */
export interface HostReport {
  running: boolean
  /** Files the PC has freed so far by this route. */
  released_total: number
}

export function parseHostReport(raw: unknown): HostReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const report = raw as Record<string, unknown>
  if (typeof report.running !== 'boolean') return null
  return { running: report.running, released_total: num(report.released_total) }
}

/**
 * Why the list may not be used now: stale (or from the future, a clock far off), a walk with
 * errors, the client running during the walk. `null` — it may.
 */
export function listBlock(meta: ListMeta, now: Date): ReleaseBlock | null {
  const finished = meta.finished_at ? Date.parse(meta.finished_at) : Number.NaN
  if (Number.isNaN(finished) || Math.abs(now.getTime() - finished) > LIST_FRESH_MS) {
    return 'list_stale'
  }
  if (meta.errors > 0) return 'list_errors'
  if (meta.client_running) return 'client_running'
  return null
}

/** `originals.release_batch`: what of it is a positive whole number, the rest by default. */
export async function batchLimits(q: Queryable): Promise<BatchLimits> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = ${BATCH_KEY} AND model_id IS NULL AND account_id IS NULL AND item_type IS NULL`)
  const value = rows[0]?.value
  const set = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const take = (key: keyof BatchLimits) => {
    const v = set[key]
    return Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : DEFAULT_BATCH[key]
  }
  return { files: take('files'), bytes: take('bytes'), first_files: take('first_files') }
}

/** The agent the owner named the host agent (`ops.js originals host-agent`), or `null`. */
export async function hostAgentId(q: Queryable): Promise<string | null> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = ${HOST_AGENT_KEY} AND model_id IS NULL AND account_id IS NULL AND item_type IS NULL`)
  const value = rows[0]?.value
  return typeof value === 'string' && value !== '' ? value : null
}

interface Candidate {
  revision_id: string
  /** Paths of the revision in its cloud, the current one first. */
  paths: string[]
  size: number
  dropbox_hash: string | null
}

/** Releasable current revisions of a live object of the model's cloud of this holder. */
async function releasable(
  q: Queryable,
  modelId: string,
  holder: ReleaseHolder,
): Promise<Candidate[]> {
  const kind = holder === 'ydisk_copy' ? 'yandex_disk' : 'dropbox'
  const { rows } = await q.execute<{
    id: string
    current_path: string
    frozen_path: string | null
    size: string
    dropbox_hash: string | null
  }>(sql`
    SELECT x.id, o.current_path, r.frozen_path, r.byte_size::text AS size,
           encode(r.content_hash, 'hex') AS dropbox_hash
      FROM (${await originalsRule(q, modelId)}) x
      JOIN source_revisions r ON r.model_id = ${modelId}::uuid AND r.id = x.id
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
     WHERE x.kind = 'revision' AND x.holder = ${kind} AND x.releasable AND NOT x.member
       AND o.current_revision_id = r.id AND o.gone_since IS NULL AND NOT o.is_dir
     ORDER BY o.current_path COLLATE "C", x.id`)
  return rows.map((row) => ({
    revision_id: row.id,
    paths: [...new Set([row.current_path, row.frozen_path].filter((p): p is string => !!p))],
    size: Number(row.size),
    dropbox_hash: row.dropbox_hash,
  }))
}

/** Files of a list by a key of their path; two names under one key — neither is trusted. */
function indexFiles(
  entries: readonly CopyListEntry[],
  key: (path: string) => string,
): Map<string, CopyListEntry | null> {
  const out = new Map<string, CopyListEntry | null>()
  for (const entry of entries) {
    if (entry.is_dir) continue
    const k = key(entry.path)
    out.set(k, out.has(k) ? null : entry)
  }
  return out
}

const fileOf = (entry: CopyListEntry, candidate: Candidate): ReleaseFile => ({
  revision_id: candidate.revision_id,
  path: entry.path.replaceAll('\\', '/'),
  size: entry.size,
  last_write_utc: entry.last_write_utc,
  attributes: entry.attributes,
  dropbox_hash: candidate.dropbox_hash,
})

/** Я.Диск: the file of the copy with its bytes on disk and the revision's size. */
async function onYdiskCopy(
  q: Queryable,
  modelId: string,
  candidates: Candidate[],
  entries: readonly CopyListEntry[],
): Promise<ReleaseFile[]> {
  const files = indexFiles(entries, relativePath)
  // The way back from a name of the copy is ambiguous (`:` and `-`): every path of the model's
  // Я.Диск, so a file of the copy that two of them could be is given to neither.
  const { rows } = await q.execute<{ path: string }>(sql`
    SELECT o.current_path AS path FROM source_objects o
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE o.model_id = ${modelId}::uuid AND s.kind = 'yandex_disk' AND NOT o.is_dir
       AND o.archive_revision_id IS NULL
    UNION
    SELECT r.frozen_path FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE r.model_id = ${modelId}::uuid AND s.kind = 'yandex_disk' AND r.frozen_path IS NOT NULL
       AND o.archive_revision_id IS NULL`)
  const index = new LocalPathIndex(rows.map((row) => row.path))
  const out: ReleaseFile[] = []
  for (const candidate of candidates) {
    const found = new Map<string, CopyListEntry>()
    for (const path of candidate.paths) {
      const local = apiToLocalPath(path)
      if (local === YDISK_SERVICE || local.startsWith(`${YDISK_SERVICE}/`)) continue
      const entry = files.get(local)
      if (!entry || index.apiPathsOf(local).length !== 1) continue
      if (entry.bytes_present === true && entry.size === candidate.size) found.set(local, entry)
    }
    // A moved file present under both of its paths: which one is this revision is not known.
    const [entry, ...more] = [...found.values()]
    if (entry && more.length === 0) out.push(fileOf(entry, candidate))
  }
  return out
}

const ariKey = (path: string) => relativePath(path).toLowerCase()

/** `E:\Ari`: the file under the Dropbox path, the revision's size, unchanged for 24 h. */
function onAriArchive(
  candidates: Candidate[],
  entries: readonly CopyListEntry[],
  now: Date,
): ReleaseFile[] {
  // Dropbox and NTFS both ignore the case of a name.
  const files = indexFiles(entries, ariKey)
  const inventory = ARI_INVENTORY.toLowerCase()
  const out: ReleaseFile[] = []
  for (const candidate of candidates) {
    if (!candidate.dropbox_hash) continue
    const [current] = candidate.paths
    if (!current) continue
    const key = ariKey(current)
    // Only files inside a type root: the root's own files (README.txt) and the inventory stay.
    if (!key.includes('/') || key.startsWith(`${inventory}/`)) continue
    const entry = files.get(key)
    if (entry?.bytes_present !== true || entry.size !== candidate.size) continue
    const written = Date.parse(entry.last_write_utc)
    if (Number.isNaN(written) || now.getTime() - written < ARI_UNCHANGED_MS) continue
    out.push(fileOf(entry, candidate))
  }
  return out
}

/** The batch: in the order given, while it fits; a file bigger than the bytes goes alone. */
export function takeBatch(
  files: readonly ReleaseFile[],
  limit: { files: number; bytes: number },
): { batch: ReleaseFile[]; left: { files: number; bytes: number } } {
  const batch: ReleaseFile[] = []
  let bytes = 0
  let at = 0
  for (; at < files.length && batch.length < limit.files; at += 1) {
    const file = files[at] as ReleaseFile
    if (batch.length > 0 && bytes + file.size > limit.bytes) break
    batch.push(file)
    bytes += file.size
  }
  const rest = files.slice(at)
  return {
    batch,
    left: { files: rest.length, bytes: rest.reduce((sum, file) => sum + file.size, 0) },
  }
}

export interface ReleaseInput {
  model: string
  holder: ReleaseHolder
  /** The host share (`ORIGINALS_HOST_DIR`); without it nothing is known about the PC. */
  hostDir: string | null
  now?: Date
}

async function readEntries(path: string): Promise<CopyListEntry[] | 'missing' | 'unreadable'> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
  try {
    return parseCopyList(text.replace(/^\uFEFF/u, ''))
  } catch {
    return 'unreadable'
  }
}

export async function originalsRelease(
  q: Queryable,
  modelId: string,
  input: ReleaseInput,
): Promise<OriginalsRelease> {
  const now = input.now ?? new Date()
  const limits = await batchLimits(q)
  const answer = (
    blocked: ReleaseBlock | null,
    meta: ListMeta | null,
    files: ReleaseFile[] = [],
    firstRun = true,
  ): OriginalsRelease => {
    const limit = {
      files: firstRun ? Math.min(limits.files, limits.first_files) : limits.files,
      bytes: limits.bytes,
      first_run: firstRun,
    }
    const { batch, left } = takeBatch(files, limit)
    return {
      model: input.model,
      holder: input.holder,
      list_finished_at:
        meta?.finished_at && !Number.isNaN(Date.parse(meta.finished_at))
          ? new Date(meta.finished_at).toISOString()
          : null,
      blocked,
      files: batch,
      limit,
      left,
    }
  }
  if (!(await isSwitchOn(q, ORIGINALS_SWITCH))) return answer('switch_off', null)
  if (HOLDER_MODEL[input.holder] !== input.model) return answer('holder_of_other_model', null)
  if (!input.hostDir) return answer('no_list', null)
  const listFile = join(
    input.hostDir,
    input.holder === 'ydisk_copy' ? COPY_LIST_FILE : ARI_LIST_FILE,
  )
  let meta: ListMeta | null
  try {
    meta = parseListMeta(await readJson(metaFileOf(listFile)))
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return answer(missing ? 'no_list' : 'list_unreadable', null)
  }
  if (!meta) return answer('list_unreadable', null)
  const stale = listBlock(meta, now)
  if (stale) return answer(stale, meta)
  let firstRun = meta.removed_total === 0
  if (input.holder === 'ydisk_copy') {
    let report: HostReport | null = { running: false, released_total: 0 }
    try {
      report = parseHostReport(await readJson(join(input.hostDir, HOST_REPORT_FILE)))
    } catch (error) {
      // No report yet: the copy has never had a session.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report = null
    }
    if (!report) return answer('host_report_unreadable', meta)
    if (report.running) return answer('session_running', meta)
    firstRun = report.released_total === 0
  }
  const entries = await readEntries(listFile)
  if (entries === 'missing') return answer('no_list', meta)
  if (entries === 'unreadable') return answer('list_unreadable', meta)
  const candidates = await releasable(q, modelId, input.holder)
  const files =
    input.holder === 'ydisk_copy'
      ? await onYdiskCopy(q, modelId, candidates, entries)
      : onAriArchive(candidates, entries, now)
  return answer(null, meta, files, firstRun)
}
