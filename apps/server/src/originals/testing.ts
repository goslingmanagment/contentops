import { createHash } from 'node:crypto'
import { dropboxContentHash } from '@contentops/sources'
import {
  assertDuplicate,
  assertWrite,
  assertWritePath,
  type CloudObject,
  type CloudSpace,
  type DuplicateTarget,
  type OriginalsTransport,
  type RemoteKind,
  TransportError,
  type UploadSource,
} from './transport'

/**
 * A fake of the clouds for the tests of the originals: objects by remote and path, with their
 * bytes or a stream that never ends; a listing can be broken; every download is counted. Writes
 * go through the same fence as rclone's (`assertWrite`); the remote's type comes from its name
 * (`mega…` — MEGA, `dropbox…` — Dropbox, `yadisk…` — Я.Диск) unless `kinds` says otherwise.
 */

export interface FakeObject {
  bytes?: Uint8Array
  /** The stream gives `bytes` up to here, then hangs until the signal aborts it. */
  stallAfter?: number
  /** Listed size when there are no bytes. */
  size?: number
  id?: string | null
  modTime?: string | null
  /** Hashes the cloud lists without a download; computed from `bytes` unless set. */
  md5?: string | null
  dropbox?: string | null
}

export class FakeClouds implements OriginalsTransport {
  readonly objects = new Map<string, Map<string, FakeObject>>()
  /** Remotes whose listing breaks. */
  readonly broken = new Set<string>()
  readonly space = new Map<string, CloudSpace>()
  /** `remote:path` of every download. */
  readonly downloads: string[] = []
  flushes = 0
  /** Which hashes the listing of a remote carries: Я.Диск — MD5, Dropbox — its own, MEGA — none. */
  readonly hashes = new Map<string, 'md5' | 'dropbox' | 'none'>()
  /** rclone's type by remote, over the guess from the name. */
  readonly kinds = new Map<string, RemoteKind>()
  /** `op remote:path` of every write that passed the fence, in order. */
  readonly writes: string[] = []
  /** `remote:path` of every `stat`, in order: what a run took first. */
  readonly stats: string[] = []
  /** Uploads the cloud stored short of their last byte (it broke them). */
  readonly corrupt = new Set<string>()
  /** Streams open now and the most at once. */
  streaming = 0
  maxOpen = 0
  /** Called when a stream has given its last byte, and right before a duplicate's fence. */
  onStreamEnd: ((remote: string, path: string) => void) | null = null
  beforeRemoveDuplicate: ((remote: string, path: string) => void) | null = null
  #ids = 0

  put(remote: string, path: string, object: FakeObject): void {
    const folder = this.objects.get(remote) ?? new Map<string, FakeObject>()
    folder.set(path, object)
    this.objects.set(remote, folder)
  }

  remove(remote: string, path: string): void {
    this.objects.get(remote)?.delete(path)
  }

  #object(path: string, object: FakeObject, remote: string): CloudObject {
    const kind = this.hashes.get(remote) ?? 'none'
    const bytes = object.bytes
    const md5 =
      object.md5 !== undefined
        ? object.md5
        : bytes
          ? createHash('md5').update(bytes).digest('hex')
          : null
    const dropbox =
      object.dropbox !== undefined ? object.dropbox : bytes ? dropboxContentHash(bytes) : null
    return {
      path,
      size: object.size ?? bytes?.length ?? 0,
      modTime: object.modTime ?? null,
      id: object.id ?? null,
      md5: kind === 'md5' ? md5 : null,
      sha256: null,
      dropbox: kind === 'dropbox' ? dropbox : null,
    }
  }

  async list(remote: string, path: string): Promise<CloudObject[]> {
    if (this.broken.has(remote)) throw new TransportError('failed', `${remote}: listing broke`)
    const prefix = path === '' ? '' : `${path.replace(/\/+$/u, '')}/`
    const out: CloudObject[] = []
    for (const [key, object] of this.objects.get(remote) ?? []) {
      if (!key.startsWith(prefix)) continue
      out.push(this.#object(key.slice(prefix.length), object, remote))
    }
    return out
  }

  async stat(remote: string, path: string): Promise<CloudObject | null> {
    this.stats.push(`${remote}:${path}`)
    const object = this.objects.get(remote)?.get(path)
    return object ? this.#object(path, object, remote) : null
  }

  async kind(remote: string): Promise<RemoteKind> {
    if (this.kinds.has(remote)) return this.kinds.get(remote) ?? null
    if (remote.startsWith('mega')) return 'mega'
    if (remote.startsWith('dropbox')) return 'dropbox'
    if (remote.startsWith('yadisk')) return 'yandex'
    return null
  }

  async #fence(remote: string, op: 'upload' | 'move' | 'remove' | 'duplicate', ...paths: string[]) {
    for (const path of paths) assertWritePath(op, path)
    const kind = await this.kind(remote)
    for (const path of paths) assertWrite(kind, op, path)
  }

  /** Reads the source to its end, as rclone would, and stores the bytes only when it ended well. */
  async upload(
    remote: string,
    path: string,
    source: UploadSource,
    signal: AbortSignal,
  ): Promise<CloudObject> {
    await this.#fence(remote, 'upload', path)
    const chunks: Uint8Array[] = []
    for await (const chunk of await source.open(signal)) chunks.push(chunk)
    let bytes: Uint8Array = Buffer.concat(chunks)
    if (bytes.length !== source.size) {
      throw new TransportError(
        'failed',
        `${remote}:${path}: ${bytes.length} of ${source.size} bytes`,
      )
    }
    // The cloud lost the last byte: its own answer (the size) gives it away.
    if (this.corrupt.has(`${remote}:${path}`)) bytes = bytes.subarray(0, bytes.length - 1)
    this.writes.push(`upload ${remote}:${path}`)
    this.#ids += 1
    this.put(remote, path, {
      bytes,
      id: `${remote}-W${this.#ids}`,
      modTime: new Date().toISOString(),
    })
    return (await this.stat(remote, path)) as CloudObject
  }

  async move(remote: string, from: string, to: string): Promise<CloudObject> {
    await this.#fence(remote, 'move', from, to)
    const folder = this.objects.get(remote)
    const object = folder?.get(from)
    if (!folder || !object)
      throw new TransportError('not_found', `${remote}:${from}: no such object`)
    if (folder.has(to)) throw new TransportError('exists', `${remote}:${to}: something is there`)
    this.writes.push(`move ${remote}:${from} -> ${to}`)
    folder.delete(from)
    folder.set(to, object)
    return (await this.stat(remote, to)) as CloudObject
  }

  async removePart(remote: string, path: string): Promise<void> {
    await this.#fence(remote, 'remove', path)
    this.writes.push(`remove ${remote}:${path}`)
    this.objects.get(remote)?.delete(path)
  }

  async removeDuplicate(remote: string, path: string, target: DuplicateTarget): Promise<void> {
    await this.#fence(remote, 'duplicate', path)
    this.beforeRemoveDuplicate?.(remote, path)
    await assertDuplicate(remote, path, await this.stat(remote, path), target)
    this.writes.push(`remove-duplicate ${remote}:${path}`)
    this.objects.get(remote)?.delete(path)
  }

  async open(remote: string, path: string, signal: AbortSignal) {
    const object = this.objects.get(remote)?.get(path)
    if (!object?.bytes) throw new TransportError('not_found', `${remote}:${path}: no such object`)
    this.downloads.push(`${remote}:${path}`)
    const bytes = object.bytes
    const stallAfter = object.stallAfter
    const clouds = this
    async function* stream(): AsyncGenerator<Uint8Array> {
      clouds.streaming += 1
      clouds.maxOpen = Math.max(clouds.maxOpen, clouds.streaming)
      try {
        const end = stallAfter ?? bytes.length
        for (let at = 0; at < end; at += 64 * 1024) {
          yield bytes.subarray(at, Math.min(at + 64 * 1024, end))
          // Another stream may run between two chunks, as with a real cloud.
          await new Promise((resolve) => setImmediate(resolve))
        }
        if (stallAfter === undefined) {
          clouds.onStreamEnd?.(remote, path)
          return
        }
        await new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      } finally {
        clouds.streaming -= 1
      }
    }
    return stream()
  }

  async about(remote: string): Promise<CloudSpace> {
    return this.space.get(remote) ?? { total: null, used: null, free: null }
  }

  async flush(): Promise<void> {
    this.flushes += 1
  }

  async close(): Promise<void> {}
}
