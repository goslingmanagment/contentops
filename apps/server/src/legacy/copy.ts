import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CopyList } from '@contentops/legacy'

/**
 * The local Я.Диск copy as a way to read the snapshot's bytes (SPEC §6.3, §12.2): a file is read
 * from `LEGACY_SOURCE_ROOT` only when the Windows list of the copy says its bytes are on disk
 * with the size of the revision; it is copied into `TMP_ROOT` first (nothing is processed over
 * `/mnt`), and kept only when the size, the MD5 and the SHA-256 of the revision match. Anything
 * else — not listed, a placeholder, another size, other bytes, a read error — goes through the
 * API as usual. The copy is never written.
 */

export interface LegacyCopyConfig {
  /** `LEGACY_SOURCE_ROOT`: the copy mounted read-only. */
  root: string
  /** `LEGACY_COPY_LIST`: the JSON Lines of `ops/winpc/ydisk-copy-list.ps1`. */
  listFile: string
}

let cached: { file: string; mtime: number; list: CopyList } | null = null

/** The list as it is now on the host share; re-read when the file changes. `null` — no list. */
export async function copyList(listFile: string): Promise<CopyList | null> {
  let mtime: number
  try {
    mtime = (await stat(listFile)).mtimeMs
  } catch {
    return null
  }
  if (cached?.file === listFile && cached.mtime === mtime) return cached.list
  const list = CopyList.parse(await readFile(listFile, 'utf8'))
  cached = { file: listFile, mtime, list }
  return list
}

export interface CopyTarget {
  /** API path of the object now (`disk:/1. PPV/…`). */
  apiPath: string
  size: number
  md5: string | null
  sha256: string | null
  /** Where the copied bytes go (under `TMP_ROOT`). */
  target: string
  signal?: AbortSignal
}

export type CopyOutcome =
  | { status: 'copied'; path: string; sha256: string; size: number }
  | { status: 'skip'; reason: string }

/** Copies one revision's bytes from the local copy and checks them, or says why not. */
export async function copyFromLocal(
  config: LegacyCopyConfig,
  input: CopyTarget,
): Promise<CopyOutcome> {
  // Without the API's MD5 nothing proves the copy holds the revision's bytes.
  if (!input.md5) return { status: 'skip', reason: 'no_md5' }
  const list = await copyList(config.listFile)
  if (!list) return { status: 'skip', reason: 'no_copy_list' }
  const file = list.readable(input.apiPath, input.size)
  if (!file) {
    const listed = list.fileOf(input.apiPath)
    return {
      status: 'skip',
      reason: !listed ? 'not_listed' : listed.bytesPresent ? 'size_differs' : 'placeholder',
    }
  }
  const relative = normalize(file.localPath)
  if (isAbsolute(relative) || relative.split(sep).includes('..')) {
    return { status: 'skip', reason: 'bad_path' }
  }
  const md5 = createHash('md5')
  const sha = createHash('sha256')
  let size = 0
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      md5.update(chunk)
      sha.update(chunk)
      size += chunk.length
      done(null, chunk)
    },
  })
  try {
    await mkdir(join(input.target, '..'), { recursive: true })
    await pipeline(
      createReadStream(join(config.root, relative)),
      hashing,
      createWriteStream(input.target),
      input.signal ? { signal: input.signal } : {},
    )
  } catch (error) {
    await rm(input.target, { force: true })
    if (input.signal?.aborted) throw error
    return {
      status: 'skip',
      reason: `read_failed:${(error as NodeJS.ErrnoException).code ?? 'io'}`,
    }
  }
  const md5Hex = md5.digest('hex')
  const shaHex = sha.digest('hex')
  const mismatch =
    size !== input.size
      ? 'size'
      : input.md5 && input.md5.toLowerCase() !== md5Hex
        ? 'md5'
        : input.sha256 && input.sha256.toLowerCase() !== shaHex
          ? 'sha256'
          : null
  if (mismatch) {
    // First a suspicion of the copy (SPEC §6.3): the frozen revision comes through the API.
    await rm(input.target, { force: true })
    return { status: 'skip', reason: `mismatch:${mismatch}` }
  }
  return { status: 'copied', path: input.target, sha256: shaHex, size }
}
