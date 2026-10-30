import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream, type ReadStream } from 'node:fs'
import { copyFile, link, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * Storage roots and keys (SPEC §9.1). The database keeps relative keys, never absolute paths:
 *
 *   blobs/sha256/ab/cd/<sha256>.<ext>       DATA_ROOT  — immutable pool by SHA-256
 *   derived/gen/<generation_id>/<name>       DERIVED_ROOT — rebuildable renditions
 *   exports/<receipt>/<name>                 TMP_ROOT   — issues with new bytes, one day
 *   staging/<sha256>.<ext>                   TMP_ROOT   — verified source bytes before the master
 *
 * Bytes leave only through `X-Accel-Redirect` to the internal nginx locations
 * (`ops/nginx/contentops.conf`): `/_accel/blobs/`, `/_accel/derived/`, `/_accel/tmp/`.
 */
export interface StorageRoots {
  dataRoot: string
  derivedRoot: string
  tmpRoot: string
}

export type StorageArea = 'blobs' | 'derived' | 'exports' | 'staging'

const HEX = /^[0-9a-f]{64}$/
const EXT = /^[a-z0-9]{1,10}$/

export function shaHex(sha: Buffer | string): string {
  const hex = typeof sha === 'string' ? sha.toLowerCase() : sha.toString('hex')
  if (!HEX.test(hex)) throw new Error(`not a SHA-256: ${hex}`)
  return hex
}

export function shaBytes(sha: Buffer | string): Buffer {
  return typeof sha === 'string' ? Buffer.from(shaHex(sha), 'hex') : sha
}

/** `blobs/sha256/ab/cd/<hex>.<ext>` (schema §3.3 `blobs.storage_key`). */
export function blobKey(sha: Buffer | string, ext: string): string {
  const hex = shaHex(sha)
  if (!EXT.test(ext)) throw new Error(`bad blob extension: ${ext}`)
  return `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.${ext}`
}

/** `derived/gen/<generation_id>/<name>` (schema §3.3 `rendition_artifacts.storage_key`). */
export function derivedKey(generationId: string, name: string): string {
  return `derived/gen/${generationId}/${name}`
}

/** `exports/<receipt>/<name>`: the exports folder of one receipt (SPEC §9.1). */
export function exportKey(receiptId: string, name: string): string {
  return `exports/${receiptId}/${name}`
}

/** Normalised lower-case extension of a file name, without the dot; `jpeg` → `jpg`. */
export function extOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  return ext === 'jpeg' ? 'jpg' : ext
}

const MIME_BY_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  jpg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  dng: 'image/x-adobe-dng',
  zip: 'application/zip',
}

export function mimeOfExt(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export interface StoredFile {
  key: string
  path: string
  bytes: number
}

/** `fsync` of a directory: the rename that put a file there survives a power loss. */
export async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function sha256OfFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path, { highWaterMark: 1 << 20, signal }), hash)
  return hash.digest('hex')
}

async function sameDevice(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)])
  return sa.dev === sb.dev
}

export class HashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`bytes changed: expected ${expected}, got ${actual}`)
    this.name = 'HashMismatchError'
  }
}

/**
 * BlobStore on the local filesystem (SPEC §9.1: `put/get/url/exists/stat/delete`). `put`
 * places verified bytes by an atomic rename without replacement inside one filesystem;
 * `delete` is called only by the owner's purge command (`storage-ops.ts`).
 */
export class BlobStore {
  readonly roots: StorageRoots

  constructor(roots: StorageRoots) {
    this.roots = {
      dataRoot: resolve(roots.dataRoot),
      derivedRoot: resolve(roots.derivedRoot),
      tmpRoot: resolve(roots.tmpRoot),
    }
  }

  /** Temp files of `put`: same filesystem as `blobs/`, so the final rename is atomic. */
  get incomingDir(): string {
    return join(this.roots.dataRoot, '.incoming')
  }

  /** Work dirs of rendition builds: same filesystem as `derived/gen/`. */
  get derivedTmpDir(): string {
    return join(this.roots.derivedRoot, '.tmp')
  }

  get stagingDir(): string {
    return join(this.roots.tmpRoot, 'staging')
  }

  get exportsDir(): string {
    return join(this.roots.tmpRoot, 'exports')
  }

  /** Absolute path of a key; a key never leaves its root. */
  path(key: string): string {
    const [area, ...rest] = key.split('/')
    const tail = rest.join('/')
    let root: string
    let inner: string
    switch (area) {
      case 'blobs':
        root = this.roots.dataRoot
        inner = key
        break
      case 'derived':
        root = this.roots.derivedRoot
        inner = tail
        break
      case 'exports':
      case 'staging':
        root = this.roots.tmpRoot
        inner = key
        break
      default:
        throw new Error(`unknown storage key: ${key}`)
    }
    const full = resolve(root, inner)
    if (!full.startsWith(root + sep)) throw new Error(`storage key escapes its root: ${key}`)
    return full
  }

  /** Internal nginx address of a key, for `X-Accel-Redirect` (never served directly). */
  url(key: string): string {
    const [area, ...rest] = key.split('/')
    const tail = rest.map(encodeURIComponent).join('/')
    switch (area) {
      case 'blobs':
        return `/_accel/blobs/${tail}`
      case 'derived':
        return `/_accel/derived/${tail}`
      case 'exports':
      case 'staging':
        return `/_accel/tmp/${area}/${tail}`
      default:
        throw new Error(`unknown storage key: ${key}`)
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key))
      return true
    } catch {
      return false
    }
  }

  async stat(key: string): Promise<{ bytes: number; mtime: Date } | null> {
    try {
      const s = await stat(this.path(key))
      return { bytes: s.size, mtime: s.mtime }
    } catch {
      return null
    }
  }

  get(key: string, options: { start?: number; end?: number } = {}): ReadStream {
    return createReadStream(this.path(key), { ...options, highWaterMark: 1 << 20 })
  }

  /**
   * Puts verified bytes under `blobs/` (schema §3.3, `storage_operations.put`): a file on
   * another filesystem is first copied into `.incoming/` and fsynced; the hash is checked
   * against `sha256`; then a link without replacement and `fsync` of the directories. The
   * same bytes already in place count as done. `move` removes the input after success.
   */
  async put(
    input: string,
    options: { sha256: string; ext: string; move?: boolean; tempName?: string },
  ): Promise<StoredFile> {
    const key = blobKey(options.sha256, options.ext)
    const target = this.path(key)
    await mkdir(this.incomingDir, { recursive: true })
    let temp = input
    let copied = false
    const local = await sameDevice(input, this.incomingDir)
    if (!local || !options.move) {
      temp = join(this.incomingDir, `${options.tempName ?? randomUUID()}.partial`)
      await copyFile(input, temp)
      copied = true
    }
    try {
      const actual = await sha256OfFile(temp)
      if (actual !== options.sha256) throw new HashMismatchError(options.sha256, actual)
      await fsyncFile(temp)
      await mkdir(dirname(target), { recursive: true })
      try {
        await link(temp, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Same name means same hash; a damaged file under it is replaced only by the
        // owner's purge first (schema §9.3 «Создание ссылки на байты»).
        const existing = await sha256OfFile(target)
        if (existing !== options.sha256) throw new HashMismatchError(options.sha256, existing)
      }
      await fsyncDir(dirname(target))
      if (copied || options.move) await unlink(temp).catch(() => undefined)
      if (copied && options.move) await unlink(input).catch(() => undefined)
      await fsyncDir(this.incomingDir).catch(() => undefined)
      const s = await stat(target)
      return { key, path: target, bytes: s.size }
    } catch (error) {
      if (copied) await rm(temp, { force: true })
      throw error
    }
  }

  /** Removes the file of a key. Only the owner's purge (and rendition eviction) call it. */
  async delete(key: string): Promise<void> {
    const path = this.path(key)
    await rm(path, { force: true, recursive: true })
    await fsyncDir(dirname(path)).catch(() => undefined)
  }

  /** Moves a finished file into its final place inside the same filesystem. */
  async place(file: string, key: string): Promise<StoredFile> {
    const target = this.path(key)
    await mkdir(dirname(target), { recursive: true })
    await rename(file, target)
    const s = await stat(target)
    return { key, path: target, bytes: s.size }
  }

  /** The staged source of `sha`, if intake left it in `staging/` (any extension). */
  async staged(sha: string): Promise<{ key: string; path: string; ext: string } | null> {
    const hex = shaHex(sha)
    let names: string[]
    try {
      names = await readdir(this.stagingDir)
    } catch {
      return null
    }
    const name = names.find((n) => n === hex || n.startsWith(`${hex}.`))
    if (!name) return null
    const key = `staging/${name}`
    return { key, path: this.path(key), ext: extOfName(name) }
  }

  /** Every blob file on disk: key and size (for `verify-blobs`). */
  async *walkBlobs(): AsyncGenerator<{ key: string; hex: string; bytes: number }> {
    const root = join(this.roots.dataRoot, 'blobs', 'sha256')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = join(entry.parentPath, entry.name)
      const hex = entry.name.split('.')[0] ?? ''
      if (!HEX.test(hex)) continue
      const s = await stat(full)
      yield { key: relative(this.roots.dataRoot, full).split(sep).join('/'), hex, bytes: s.size }
    }
  }
}
