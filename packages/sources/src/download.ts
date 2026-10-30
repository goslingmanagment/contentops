import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSourceError, SourceError } from './errors.ts'
import { DigestSet, type Digests } from './hashes.ts'
import { backoffDelay, DEFAULT_RETRY, type RetryPolicy, sleep } from './retry.ts'
import type { CloudSource, SourceEntry } from './types.ts'

export const PARTIAL_SUFFIX = '.partial'

export interface VerifiedDownloadOptions {
  /** Where the file lands; the `.partial` lives next to it (same filesystem → atomic rename). */
  targetDir: string
  /** Final file name; the entry's name by default. */
  fileName?: string
  signal?: AbortSignal
  /** Pauses between resumes after a cut, a 5xx or a 429. Progress resets the count. */
  retry?: RetryPolicy
  onProgress?: (bytes: number, total: number) => void
}

export type VerifiedDownload =
  | {
      status: 'verified'
      path: string
      size: number
      /** `source_sha256`, computed on the fly. */
      sha256: string
      md5: string | null
      contentHash: string | null
      /** Bytes already in the `.partial` when this call started. */
      resumedFrom: number
    }
  | {
      /**
       * «Изменился во время скачивания»: the bytes are not those of the observed revision.
       * The `.partial` is removed; the caller records a new revision from `current`
       * (null when the file is gone) and downloads that.
       */
      status: 'changed'
      reason: string
      current: SourceEntry | null
    }

class Changed extends Error {}

/**
 * Downloads an entry into `<targetDir>/<name>`: bytes go to `<name>.partial`, SHA-256 (and
 * MD5 for Yandex, `content_hash` for Dropbox) are computed while writing, a cut resumes from
 * the partial's size, the size and the source checksum are verified at the end, then the
 * file is fsynced and renamed. An abort leaves only the `.partial` (resumable); nothing
 * unverified ever carries the final name.
 */
export async function downloadVerified(
  source: CloudSource,
  entry: SourceEntry,
  o: VerifiedDownloadOptions,
): Promise<VerifiedDownload> {
  if (entry.isDir || entry.size == null) throw new TypeError('only files with a size download')
  const name = o.fileName ?? entry.name
  if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) {
    throw new TypeError(`unsafe file name: ${JSON.stringify(name)}`)
  }
  const policy = o.retry ?? DEFAULT_RETRY
  const wait = policy.sleep ?? sleep
  const expected = entry.size
  const finalPath = join(o.targetDir, name)
  const partial = finalPath + PARTIAL_SUFFIX
  await mkdir(o.targetDir, { recursive: true })

  let resumedFrom: number | null = null
  let restartedAfterMismatch = false
  let failures = 0
  for (;;) {
    o.signal?.throwIfAborted()
    let have = await sizeOf(partial)
    if (have > expected) {
      await truncate(partial, 0)
      have = 0
    }
    resumedFrom ??= have
    await writeFile(partial, '', { flag: 'a' })
    let digests = digestsFor(entry)
    await hashExisting(partial, have, digests, o.signal)

    const progress = { answered: false, bytes: false }
    try {
      if (have < expected) {
        ;({ have, digests } = await fetchInto(source, entry, partial, have, digests, o, progress))
      }
    } catch (e) {
      if (e instanceof Changed || isSourceError(e, 'bad_response', 'range_not_satisfiable')) {
        const now = await lookAgain(source, entry, o.signal)
        return changed(
          partial,
          e instanceof Changed ? e.message : 'range not satisfiable',
          now.current,
        )
      }
      if (isSourceError(e, 'not_found')) {
        // The observed revision is not there any more: changed or gone, or a real error.
        const now = await lookAgain(source, entry, o.signal)
        if (now.differs) return changed(partial, now.reason, now.current)
        throw e
      }
      // The client already retried the request itself; here only a cut body is resumed.
      if (!isSourceError(e) || !e.retryable || !progress.answered) throw e
      failures = progress.bytes ? 1 : failures + 1
      if (failures >= policy.attempts) throw e
      if (e.retryAfterMs != null && e.retryAfterMs > policy.maxDelayMs) throw e
      const delay = backoffDelay(failures, policy, e.retryAfterMs)
      policy.onRetry?.(e, failures, delay)
      await wait(delay, o.signal)
      continue
    }

    const got = digests.digest()
    const mismatch = compare(entry, have, got)
    if (!mismatch) {
      await syncFile(partial)
      await rename(partial, finalPath)
      await syncDir(o.targetDir)
      return {
        status: 'verified',
        path: finalPath,
        size: have,
        sha256: got.sha256,
        md5: got.md5,
        contentHash: got.contentHash,
        resumedFrom,
      }
    }
    // A mismatch is either a change at the source or a damaged transfer: ask the source.
    const now = await lookAgain(source, entry, o.signal)
    if (now.differs) return changed(partial, `${mismatch}; ${now.reason}`, now.current)
    await rm(partial, { force: true })
    if (restartedAfterMismatch) {
      throw new SourceError('bad_response', `${mismatch} twice for an unchanged file`, {
        source: entry.source,
        endpoint: 'download',
        code: 'checksum_mismatch',
      })
    }
    restartedAfterMismatch = true
  }
}

async function fetchInto(
  source: CloudSource,
  entry: SourceEntry,
  partial: string,
  from: number,
  digests: DigestSet,
  o: VerifiedDownloadOptions,
  progress: { answered: boolean; bytes: boolean },
): Promise<{ have: number; digests: DigestSet }> {
  const expected = entry.size as number
  const res = await source.download(entry, {
    offset: from,
    ...(o.signal ? { signal: o.signal } : {}),
  })
  progress.answered = true
  let have = from
  if (res.offset !== from) {
    // The server ignored Range and sends the whole file: start the partial over.
    if (res.offset !== 0) throw new Changed(`server resumed at ${res.offset} instead of ${from}`)
    await truncate(partial, 0)
    digests = digestsFor(entry)
    have = 0
  }
  if (res.totalSize != null && res.totalSize !== expected) {
    throw new Changed(`size is ${res.totalSize} now, was ${expected}`)
  }
  if (res.remote?.rev && entry.rev && res.remote.rev !== entry.rev) {
    throw new Changed(`revision is ${res.remote.rev} now, was ${entry.rev}`)
  }
  const file = await open(partial, 'a')
  try {
    for await (const chunk of res.body) {
      if (have + chunk.length > expected) throw new Changed(`more than ${expected} bytes`)
      await file.write(chunk)
      digests.update(chunk)
      have += chunk.length
      progress.bytes = true
      o.onProgress?.(have, expected)
    }
  } finally {
    await file.close()
  }
  return { have, digests }
}

function digestsFor(entry: SourceEntry): DigestSet {
  return new DigestSet({ md5: entry.md5 != null, contentHash: entry.contentHash != null })
}

function compare(entry: SourceEntry, size: number, got: Digests): string | null {
  if (size !== entry.size) return `size ${size} ≠ ${entry.size}`
  if (entry.md5 && got.md5 !== entry.md5.toLowerCase()) return 'md5 differs'
  if (entry.sha256 && got.sha256 !== entry.sha256.toLowerCase()) return 'sha256 differs'
  if (entry.contentHash && got.contentHash !== entry.contentHash.toLowerCase()) {
    return 'content_hash differs'
  }
  return null
}

/** The source's current view of the entry and whether it differs (changed or gone). */
async function lookAgain(
  source: CloudSource,
  entry: SourceEntry,
  signal?: AbortSignal,
): Promise<{ differs: boolean; reason: string; current: SourceEntry | null }> {
  let current: SourceEntry
  try {
    current = await source.stat(
      entry.id && source.kind === 'dropbox' ? { id: entry.id } : { path: entry.path.raw },
      signal ? { signal } : {},
    )
  } catch (e) {
    if (isSourceError(e, 'not_found'))
      return { differs: true, reason: 'gone at the source', current: null }
    throw e
  }
  const differs =
    current.id !== entry.id ||
    current.size !== entry.size ||
    current.md5 !== entry.md5 ||
    current.sha256 !== entry.sha256 ||
    current.contentHash !== entry.contentHash ||
    current.rev !== entry.rev
  return { differs, reason: differs ? 'the source has a different revision' : 'unchanged', current }
}

async function changed(
  partial: string,
  reason: string,
  current: SourceEntry | null,
): Promise<VerifiedDownload> {
  await rm(partial, { force: true })
  return { status: 'changed', reason: `изменился во время скачивания: ${reason}`, current }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
}

async function hashExisting(
  path: string,
  bytes: number,
  digests: DigestSet,
  signal?: AbortSignal,
): Promise<void> {
  if (bytes === 0) return
  const stream = createReadStream(path, {
    start: 0,
    end: bytes - 1,
    highWaterMark: 1 << 20,
    ...(signal ? { signal } : {}),
  })
  for await (const chunk of stream) digests.update(chunk as Buffer)
}

async function syncFile(path: string): Promise<void> {
  const fh = await open(path, 'r+')
  try {
    await fh.sync()
  } finally {
    await fh.close()
  }
}

async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r')
  try {
    await fh.sync()
  } catch {
    // some filesystems refuse fsync on a directory; the rename itself is atomic
  } finally {
    await fh.close()
  }
}
