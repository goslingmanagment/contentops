import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { downloadVerified } from './download.ts'
import {
  createDropboxSource,
  DROPBOX_ENDPOINTS,
  DROPBOX_TOKEN_ENDPOINT,
  dropboxRefreshToken,
} from './dropbox.ts'
import {
  type FakeDropbox,
  type FakeYandexDisk,
  recordingRetry,
  startFakeDropbox,
  startFakeYandexDisk,
} from './testing/index.ts'
import type { CloudSource } from './types.ts'
import { createYandexDiskSource, YANDEX_DISK_ENDPOINTS } from './yandex-disk.ts'

/**
 * ContentOps only reads the models' clouds (SPEC §6.1, §2.1 п. 6). The endpoint lists are
 * spelled out here: adding anything to them — or calling anything else — fails this test.
 */
const YANDEX_ALLOWED = [
  '/v1/disk',
  '/v1/disk/resources',
  '/v1/disk/resources/last-uploaded',
  '/v1/disk/resources/download',
]
const DROPBOX_ALLOWED = [
  'files/list_folder',
  'files/list_folder/continue',
  'files/list_folder/get_latest_cursor',
  'files/get_metadata',
  'files/download',
  'files/get_thumbnail_v2',
  'users/get_space_usage',
]

let yd: FakeYandexDisk
let dbx: FakeDropbox
let dir: string

async function exercise(src: CloudSource): Promise<void> {
  const first = await src.recent(null)
  await src.recent(first.cursor)
  const files = []
  for await (const e of src.traverse())
    if (e.type === 'entry' && !e.entry.isDir) files.push(e.entry)
  const photo = files.find((f) => f.name === 'a.jpg')
  if (!photo) throw new Error('no a.jpg')
  await src.stat({ path: photo.path.raw })
  await src.thumbnail(photo)
  await src.space()
  await downloadVerified(src, photo, {
    targetDir: join(dir, src.kind),
    retry: recordingRetry().policy,
  })
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sources-ro-'))
  yd = await startFakeYandexDisk()
  dbx = await startFakeDropbox({ refresh: { refreshToken: 'r', appKey: 'k' } })
  for (const t of [yd.tree, dbx.tree]) {
    t.addFile('/Model/a.jpg', 5000)
    t.addFile('/Model/Set/b.mp4', 7000)
  }
  // Ask a token first, so the token endpoint is exercised too.
  const token = dropboxRefreshToken({ refreshToken: 'r', appKey: 'k', apiBase: dbx.url })
  await exercise(createYandexDiskSource({ token: yd.token, root: '/Model', apiBase: yd.url }))
  await exercise(
    createDropboxSource({ token, root: '/Model', apiBase: dbx.url, contentBase: dbx.url }),
  )
})

afterAll(async () => {
  await Promise.all([yd.close(), dbx.close()])
  await rm(dir, { recursive: true, force: true })
})

describe('read-only by construction', () => {
  it('the clients declare only read endpoints', () => {
    expect([...YANDEX_DISK_ENDPOINTS]).toEqual(YANDEX_ALLOWED)
    expect([...DROPBOX_ENDPOINTS]).toEqual(DROPBOX_ALLOWED)
    expect(DROPBOX_TOKEN_ENDPOINT).toBe('oauth2/token')
  })

  it('Yandex Disk saw only GET to the read endpoints and the links the API gave', () => {
    expect(new Set(yd.requests.map((r) => r.method))).toEqual(new Set(['GET']))
    const seen = new Set(yd.requests.map((r) => r.endpoint))
    expect(
      [...seen].filter((e) => ![...YANDEX_ALLOWED, 'download', 'preview'].includes(e)),
    ).toEqual([])
    expect(seen).toEqual(new Set([...YANDEX_ALLOWED, 'download', 'preview']))
  })

  it('Dropbox saw only the read endpoints (and the token refresh)', () => {
    const seen = new Set(dbx.requests.map((r) => r.endpoint))
    expect([...seen].filter((e) => ![...DROPBOX_ALLOWED, 'oauth2/token'].includes(e))).toEqual([])
    expect(seen).toEqual(new Set([...DROPBOX_ALLOWED, 'oauth2/token']))
  })

  it('no source file names a write endpoint or a write method', async () => {
    const src = new URL('.', import.meta.url).pathname
    const names = (await readdir(src)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(names.length).toBeGreaterThan(5)
    const yandexLiteral = /['"`](\/v1\/disk[^'"`?]*)/g
    const dropboxLiteral =
      /['"`]((?:files|users|sharing|file_requests|team|paper|account|contacts)\/[a-z0-9_/]*)['"`]/g
    let literals = 0
    for (const name of names) {
      const code = await readFile(join(src, name), 'utf8')
      for (const m of code.matchAll(yandexLiteral)) {
        literals++
        expect(YANDEX_ALLOWED, name).toContain(m[1])
      }
      for (const m of code.matchAll(dropboxLiteral)) {
        literals++
        expect(DROPBOX_ALLOWED, name).toContain(m[1])
      }
      expect(code, name).not.toMatch(/method:\s*['"`](PUT|PATCH|DELETE)['"`]/)
      if (name === 'yandex-disk.ts') expect(code).not.toMatch(/method:\s*['"`]POST['"`]/)
    }
    expect(literals).toBeGreaterThanOrEqual(YANDEX_ALLOWED.length + DROPBOX_ALLOWED.length)
  })
})
