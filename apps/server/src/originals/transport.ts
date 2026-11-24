/**
 * How the originals reach the clouds (SPEC §9.4): one thin interface over rclone — the list of a
 * folder with hashes and IDs, one object, its bytes, free space and a flush of what rclone keeps
 * of the clouds. The real one is `RcloneTransport` (`rclone.ts`), the tests use a fake
 * (`testing.ts`). This step only reads: the interface has no writing call, and the rclone client
 * refuses every command outside `READ_COMMANDS` before it reaches rclone. Writing comes later,
 * under fixed prefixes (`Архив Я.Диска/`, `Загрузки ContentOps/`, `originals/`).
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
  /** Stops the transport (the rclone process); a later call starts it again. */
  close(): Promise<void>
}

export type TransportErrorCode = 'not_found' | 'refused' | 'failed'

export class TransportError extends Error {
  readonly code: TransportErrorCode

  constructor(code: TransportErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'TransportError'
    this.code = code
  }
}

/** The rc commands this step may send: lists, one object, space, the flush, the version. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'core/version',
  'operations/list',
  'operations/stat',
  'operations/about',
  'fscache/clear',
])

/** Throws before anything is sent when a command could change a cloud. */
export function assertReadCommand(command: string): void {
  if (!READ_COMMANDS.has(command)) {
    throw new TransportError('refused', `${command}: originals only read the clouds in this step`)
  }
}
