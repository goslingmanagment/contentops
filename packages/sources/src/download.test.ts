import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadVerified } from './download.ts'
import { createDropboxSource } from './dropbox.ts'
import { isSourceError } from './errors.ts'
import { dropboxContentHash } from './hashes.ts'
import {
  type FakeDropbox,
  type FakeYandexDisk,
  fakeBytes,
  md5Hex,
  recordingRetry,
  sha256Hex,
  startFakeDropbox,
  startFakeYandexDisk,
} from './testing/index.ts'
import type { CloudSource } from './types.ts'
import { createYandexDiskSource } from './yandex-disk.ts'

const SIZE = 300_000
let dir: string
let yd: FakeYandexDisk
let dbx: FakeDropbox

function yandex(): CloudSource {
  return createYandexDiskSource({
    token: yd.token,
    root: '/Model',
    apiBase: yd.url,
    retry: recordingRetry().policy,
  })
}

function dropbox(): CloudSource {
  return createDropboxSource({
    token: dbx.token,
    root: '/Model',
    apiBase: dbx.url,
    contentBase: dbx.url,
    retry: recordingRetry().policy,
  })
}

const retry = () => recordingRetry({ attempts: 4 }).policy

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sources-dl-'))
  yd = await startFakeYandexDisk()
  dbx = await startFakeDropbox()
  yd.tree.addFile('/Model/clip.mp4', SIZE)
  dbx.tree.addFile('/Model/clip.mp4', SIZE)
})

afterEach(async () => {
  await Promise.all([yd.close(), dbx.close()])
  await rm(dir, { recursive: true, force: true })
})

describe('verified download, Yandex Disk', () => {
  it('writes the file under its name with SHA-256 and MD5 checked', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    const bytes = yd.tree.get('/Model/clip.mp4')?.bytes as Buffer
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({
      status: 'verified',
      size: SIZE,
      sha256: sha256Hex(bytes),
      md5: md5Hex(bytes),
      resumedFrom: 0,
    })
    expect(await readdir(dir)).toEqual(['clip.mp4'])
    expect(sha256Hex(await readFile(join(dir, 'clip.mp4')))).toBe(sha256Hex(bytes))
    // The pre-signed href does not get the token.
    expect(yd.calls('download')[0]?.headers.authorization).toBeUndefined()
  })

  it('resumes from the cut byte with Range', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    yd.fail('cut', { endpoint: 'download', afterBytes: 100_000 })
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r.status).toBe('verified')
    const ranges = yd.calls('download').map((c) => c.headers.range)
    expect(ranges[0]).toBeUndefined()
    expect(ranges[1]).toMatch(/^bytes=\d+-$/)
    expect(Number(ranges[1]?.slice(6, -1))).toBeGreaterThan(0)
    expect(await readdir(dir)).toEqual(['clip.mp4'])
  })

  it('an abort leaves only the .partial, and the next call resumes it', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    const ac = new AbortController()
    const first = downloadVerified(src, entry, {
      targetDir: dir,
      fileName: 'rev-1.mp4',
      signal: ac.signal,
      retry: retry(),
      onProgress: (bytes) => {
        if (bytes > 0) ac.abort()
      },
    })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(dir)).toEqual(['rev-1.mp4.partial'])

    const r = await downloadVerified(src, entry, {
      targetDir: dir,
      fileName: 'rev-1.mp4',
      retry: retry(),
    })
    expect(r).toMatchObject({ status: 'verified' })
    if (r.status === 'verified') expect(r.resumedFrom).toBeGreaterThan(0)
    expect(await readdir(dir)).toEqual(['rev-1.mp4'])
  })

  it('a damaged transfer is downloaded again; a persistent mismatch is an error', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    yd.fail('corrupt', { endpoint: 'download' })
    const ok = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(ok.status).toBe('verified')
    expect(yd.calls('download')).toHaveLength(2)

    yd.fail('corrupt', { endpoint: 'download', times: 2 })
    const err = await downloadVerified(src, entry, {
      targetDir: dir,
      fileName: 'again.mp4',
      retry: retry(),
    }).catch((e: unknown) => e)
    expect(isSourceError(err, 'bad_response', 'checksum_mismatch')).toBe(true)
    expect(await readdir(dir)).toEqual(['clip.mp4'])
  })

  it('a garbage .partial is caught by the checksum and replaced', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    await writeFile(join(dir, 'clip.mp4.partial'), fakeBytes(1000, 'garbage'))
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r.status).toBe('verified')
    expect(yd.calls('download').map((c) => c.headers.range)).toEqual(['bytes=1000-', undefined])
  })

  it('same size, new bytes during the download: «изменился во время скачивания»', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    yd.fail('cut', { endpoint: 'download', afterBytes: 100_000 })
    let replaced = false
    const r = await downloadVerified(src, entry, {
      targetDir: dir,
      retry: retry(),
      onProgress: () => {
        if (!replaced) {
          replaced = true
          yd.tree.replace('/Model/clip.mp4', SIZE)
        }
      },
    })
    expect(r.status).toBe('changed')
    if (r.status !== 'changed') return
    expect(r.reason).toMatch(/^изменился во время скачивания/)
    expect(r.current?.id).toBe(entry.id)
    expect(r.current?.md5).not.toBe(entry.md5)
    expect(await readdir(dir)).toEqual([])
  })

  it('a new size is caught on resume from Content-Range, a gone file has no current', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    await writeFile(
      join(dir, 'clip.mp4.partial'),
      yd.tree.get('/Model/clip.mp4')?.bytes?.subarray(0, 1000) as Buffer,
    )
    yd.tree.replace('/Model/clip.mp4', SIZE + 10)
    const bigger = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(bigger).toMatchObject({ status: 'changed', current: { size: SIZE + 10 } })
    expect(yd.calls('download')).toHaveLength(1)

    await writeFile(join(dir, 'clip.mp4.partial'), Buffer.alloc(1000))
    const fresh = await src.stat({ path: '/Model/clip.mp4' })
    yd.tree.remove('/Model/clip.mp4')
    const gone = await downloadVerified(src, fresh, { targetDir: dir, retry: retry() })
    expect(gone).toMatchObject({ status: 'changed', current: null })
    expect(await readdir(dir)).toEqual([])
  })

  it('a shorter file answers 416 on resume and counts as changed', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    await writeFile(join(dir, 'clip.mp4.partial'), Buffer.alloc(200_000))
    yd.tree.replace('/Model/clip.mp4', 100_000)
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({ status: 'changed', current: { size: 100_000 } })
  })

  it('a server that ignores Range restarts the partial from zero', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    const bytes = yd.tree.get('/Model/clip.mp4')?.bytes as Buffer
    await writeFile(join(dir, 'clip.mp4.partial'), bytes.subarray(0, 5000))
    yd.ignoreRange = true
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({ status: 'verified', sha256: sha256Hex(bytes) })
  })

  it('an empty file is verified without a request', async () => {
    yd.tree.addFile('/Model/empty.txt', 0)
    const src = yandex()
    const entry = await src.stat({ path: '/Model/empty.txt' })
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({ status: 'verified', size: 0, sha256: sha256Hex(Buffer.alloc(0)) })
    expect(await readdir(dir)).toEqual(['empty.txt'])
  })

  it('a failing link request is retried by the client only, not again by the helper', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    yd.fail('server_error', { endpoint: '/v1/disk/resources/download', times: 100 })
    const err = await downloadVerified(src, entry, { targetDir: dir, retry: retry() }).catch(
      (e: unknown) => e,
    )
    expect(isSourceError(err, 'transient')).toBe(true)
    expect(yd.calls('/v1/disk/resources/download')).toHaveLength(4)
  })

  it('a rejected token stops the download with the partial kept', async () => {
    const src = yandex()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    yd.fail('cut', { endpoint: 'download', afterBytes: 50_000 })
    // The first link works; asking for the second (to resume) is rejected.
    let calls = 0
    yd.beforeReply = (req) => {
      if (req.endpoint === '/v1/disk/resources/download' && ++calls === 2) yd.token = 'rotated'
    }
    const err = await downloadVerified(src, entry, { targetDir: dir, retry: retry() }).catch(
      (e: unknown) => e,
    )
    expect(isSourceError(err, 'auth_rejected')).toBe(true)
    expect(await readdir(dir)).toEqual(['clip.mp4.partial'])
  })
})

describe('verified download, Dropbox', () => {
  it('checks content_hash over several 4 MiB blocks and resumes with Range', async () => {
    const big = fakeBytes(9 * 1024 * 1024 + 123, 'big')
    dbx.tree.addFile('/Model/big.mov', big)
    const src = dropbox()
    const entry = await src.stat({ path: '/Model/big.mov' })
    expect(entry.contentHash).toBe(dropboxContentHash(big))
    dbx.fail('cut', { endpoint: 'files/download', afterBytes: 5 * 1024 * 1024 })
    const r = await downloadVerified(src, entry, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({
      status: 'verified',
      contentHash: entry.contentHash,
      sha256: sha256Hex(big),
      md5: null,
    })
    const calls = dbx.calls('files/download')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.headers.range).toMatch(/^bytes=\d+-$/)
    expect(JSON.parse(calls[1]?.headers['dropbox-api-arg'] as string)).toEqual({
      path: `rev:${entry.rev}`,
    })
  })

  it('pins the observed revision: a change at the source does not mix bytes', async () => {
    const src = dropbox()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    const original = dbx.tree.get('/Model/clip.mp4')?.bytes as Buffer
    dbx.fail('cut', { endpoint: 'files/download', afterBytes: 100_000 })
    let replaced = false
    const r = await downloadVerified(src, entry, {
      targetDir: dir,
      retry: retry(),
      onProgress: () => {
        if (!replaced) {
          replaced = true
          dbx.tree.replace('/Model/clip.mp4', SIZE)
        }
      },
    })
    expect(r).toMatchObject({ status: 'verified', sha256: sha256Hex(original) })
  })

  it('a revision that is no longer there reports the current one', async () => {
    const src = dropbox()
    const entry = await src.stat({ path: '/Model/clip.mp4' })
    dbx.tree.replace('/Model/clip.mp4', SIZE)
    const stale = { ...entry, rev: 'ffffffffff' }
    const r = await downloadVerified(src, stale, { targetDir: dir, retry: retry() })
    expect(r).toMatchObject({
      status: 'changed',
      current: { rev: dbx.tree.get('/Model/clip.mp4')?.rev },
    })
    expect(await readdir(dir)).toEqual([])
  })
})
