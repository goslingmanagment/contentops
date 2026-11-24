import { nfc } from '@contentops/sources'

/**
 * How the originals reach the clouds (SPEC §9.4): one thin interface over rclone — the list of a
 * folder with hashes and IDs, one object, its bytes, free space, a flush of what rclone keeps of
 * the clouds, and three writes. The real one is `RcloneTransport` (`rclone.ts`), the tests use a
 * fake (`testing.ts`).
 *
 * The writes are fenced here, before anything reaches rclone (`assertWrite`):
 *
 * - only into a remote whose rclone type is MEGA (under `originals/`) or Dropbox (under the
 *   folders of ContentOps there: `Архив Я.Диска/`, `Загрузки ContentOps/`); Я.Диск and anything
 *   else is never written;
 * - `upload` only to a `<name>.co-part`; `move` never onto an existing object;
 * - `removePart` only of a `.co-part`, and only in MEGA: in Dropbox nothing is ever deleted.
 *
 * There is no other writing call, and the rclone client sends no other writing command.
 */

/** A file of a cloud as rclone lists it. */
export interface CloudObject {
  /** Relative to the folder that was listed (or the path asked for, for `stat`). */
  path: string
  size: number
  /** When the object appeared (MEGA) or was modified, ISO; null when the cloud says nothing. */
  modTime: string | null
  /** The provider's ID of the very object (MEGA node, Dropbox `id:…`). */
  id: string | null
  /** Hashes the cloud lists without a download, lower-case hex. */
  md5: string | null
  sha256: string | null
  dropbox: string | null
}

export interface CloudSpace {
  total: number | null
  used: number | null
  free: number | null
}

/** The bytes of one write, re-readable: rclone may read them again from the start. */
export interface UploadSource {
  size: number
  /** A fresh stream from the first byte; it ends with an error when the bytes must not land. */
  open(signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
}

/** rclone's type of a remote (`mega`, `dropbox`, `yandex`, …); null — no such remote. */
export type RemoteKind = string | null

export interface OriginalsTransport {
  /** Every file under `remote:path`, recursively; throws when the listing is not whole. */
  list(remote: string, path: string, signal?: AbortSignal): Promise<CloudObject[]>
  /** One object, `null` when there is none. */
  stat(remote: string, path: string, signal?: AbortSignal): Promise<CloudObject | null>
  /** The bytes of one object; the stream ends with an error when `signal` aborts. */
  open(remote: string, path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
  about(remote: string, signal?: AbortSignal): Promise<CloudSpace>
  /** Forgets what rclone keeps of the clouds: the next call reads them anew (MEGA's tree). */
  flush(signal?: AbortSignal): Promise<void>
  /** rclone's type of the remote, the first thing every write asks. */
  kind(remote: string, signal?: AbortSignal): Promise<RemoteKind>
  /**
   * Writes `source` to `remote:path` (a `.co-part`) and returns the object as the cloud now
   * lists it; nothing lands when the source's stream ends with an error.
   */
  upload(
    remote: string,
    path: string,
    source: UploadSource,
    signal: AbortSignal,
  ): Promise<CloudObject>
  /** Moves an object inside the remote; refuses when something lies at `to`. */
  move(remote: string, from: string, to: string, signal?: AbortSignal): Promise<CloudObject>
  /** Deletes our own `.co-part` in MEGA; anything else is refused. */
  removePart(remote: string, path: string, signal?: AbortSignal): Promise<void>
  /** Stops the transport (the rclone process); a later call starts it again. */
  close(): Promise<void>
}

export type TransportErrorCode = 'not_found' | 'refused' | 'failed' | 'exists'

export class TransportError extends Error {
  readonly code: TransportErrorCode

  constructor(code: TransportErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'TransportError'
    this.code = code
  }
}

/** The rc commands that only read: lists, one object, space, the flush, the version, a type. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'core/version',
  'operations/list',
  'operations/stat',
  'operations/about',
  'fscache/clear',
  'config/get',
])

/** The only rc commands that change a cloud; each is sent only after `assertWrite`. */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'operations/copyfile',
  'operations/movefile',
  'operations/deletefile',
])

/** Throws before anything is sent when a command could change a cloud. */
export function assertReadCommand(command: string): void {
  if (!READ_COMMANDS.has(command)) {
    throw new TransportError('refused', `${command}: not a reading command`)
  }
}

export const PART_SUFFIX = '.co-part'
export const MEGA_ROOT = 'originals'
export const ARCHIVE_FOLDER = 'Архив Я.Диска'
export const UPLOADS_FOLDER = 'Загрузки ContentOps'

/** Where each kind of cloud may be written: folders at the remote's root. */
export const WRITE_ROOTS: Readonly<Record<string, readonly string[]>> = {
  mega: [MEGA_ROOT],
  dropbox: [ARCHIVE_FOLDER, UPLOADS_FOLDER],
}

export type WriteOp = 'upload' | 'move' | 'remove'

const lower = (text: string) => nfc(text).toLowerCase()

/** A clean relative path: no leading slash, no empty or dot components. */
function cleanPath(path: string): string[] | null {
  if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('\0')) return null
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts
}

/** The root folder of `path` among `roots`, compared as Dropbox compares (NFC, no case). */
function rootOf(parts: string[], roots: readonly string[]): string | null {
  const [first] = parts
  if (first === undefined || parts.length < 2) return null
  return roots.find((root) => lower(root) === lower(first)) ?? null
}

/**
 * The first fence, from the path alone (no rclone needed): a write goes only under one of the
 * roots of some writable cloud, an upload or a delete only to a `.co-part`.
 */
export function assertWritePath(op: WriteOp, path: string): void {
  const parts = cleanPath(path)
  if (!parts) throw new TransportError('refused', `${op} ${path}: not a clean relative path`)
  const all = Object.values(WRITE_ROOTS).flat()
  if (!rootOf(parts, all)) {
    throw new TransportError('refused', `${op} ${path}: outside the folders ContentOps writes`)
  }
  if ((op === 'upload' || op === 'remove') && !path.endsWith(PART_SUFFIX)) {
    throw new TransportError('refused', `${op} ${path}: only a ${PART_SUFFIX} is ${op}ed`)
  }
}

/**
 * The whole fence: the path, then the cloud by its rclone type — MEGA under `originals/`, Dropbox
 * under its two folders, a delete only in MEGA. Я.Диск and any other type are never written.
 */
export function assertWrite(kind: RemoteKind, op: WriteOp, path: string): void {
  assertWritePath(op, path)
  const roots = kind ? WRITE_ROOTS[kind] : undefined
  if (!roots)
    throw new TransportError(
      'refused',
      `${op} ${path}: a ${kind ?? 'missing'} remote is never written`,
    )
  const parts = cleanPath(path) as string[]
  if (!rootOf(parts, roots)) {
    throw new TransportError('refused', `${op} ${path}: not a folder ContentOps writes in ${kind}`)
  }
  if (op === 'remove' && kind !== 'mega') {
    throw new TransportError('refused', `remove ${path}: nothing is deleted in ${kind}`)
  }
}
