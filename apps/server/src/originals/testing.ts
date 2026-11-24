import { createHash } from 'node:crypto'
import { dropboxContentHash } from '@contentops/sources'
import {
  type CloudObject,
  type CloudSpace,
  type OriginalsTransport,
  TransportError,
} from './transport'

/**
 * A fake of the clouds for the tests of the originals: objects by remote and path, with their
 * bytes or a stream that never ends; a listing can be broken; every download is counted.
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
    const object = this.objects.get(remote)?.get(path)
    return object ? this.#object(path, object, remote) : null
  }

  async open(remote: string, path: string, signal: AbortSignal) {
    const object = this.objects.get(remote)?.get(path)
    if (!object?.bytes) throw new TransportError('not_found', `${remote}:${path}: no such object`)
    this.downloads.push(`${remote}:${path}`)
    const bytes = object.bytes
    const stallAfter = object.stallAfter
    async function* stream(): AsyncGenerator<Uint8Array> {
      const end = stallAfter ?? bytes.length
      for (let at = 0; at < end; at += 64 * 1024) {
        yield bytes.subarray(at, Math.min(at + 64 * 1024, end))
      }
      if (stallAfter === undefined) return
      await new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
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
