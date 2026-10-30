import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDropboxSource, dropboxRefreshToken, headerJson } from './dropbox.ts'
import { isSourceError, type SourceError } from './errors.ts'
import { dropboxContentHash } from './hashes.ts'
import { type FakeDropbox, recordingRetry, startFakeDropbox } from './testing/index.ts'
import type { CloudSource, SourceEntry, TraverseEvent } from './types.ts'

let fake: FakeDropbox
let delays: number[]

function source(o: { pageSize?: number; root?: string; token?: string } = {}): CloudSource {
  const retry = recordingRetry()
  delays = retry.delays
  return createDropboxSource({
    token: o.token ?? fake.token,
    root: o.root ?? '/Model',
    apiBase: fake.url,
    contentBase: fake.url,
    retry: retry.policy,
    pageSize: o.pageSize ?? 3,
  })
}

async function collect(it: AsyncIterable<TraverseEvent>): Promise<TraverseEvent[]> {
  const out: TraverseEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const entries = (events: TraverseEvent[]) =>
  events.flatMap((e) => (e.type === 'entry' ? [e.entry] : []))
const endOf = (events: TraverseEvent[]) => events.at(-1) as Extract<TraverseEvent, { type: 'end' }>

async function rejection(p: Promise<unknown>): Promise<SourceError> {
  try {
    await p
  } catch (e) {
    if (isSourceError(e)) return e
    throw e
  }
  throw new Error('expected a SourceError')
}

beforeEach(async () => {
  fake = await startFakeDropbox()
  const t = fake.tree
  t.addFile('/Model/a.jpg', 1000, { shotAt: new Date('2026-09-01T12:00:00Z') })
  t.addFile('/Model/b.mp4', 2000)
  for (let i = 0; i < 5; i++) t.addFile(`/Model/Set 1/${i}.heic`, 100 + i)
  t.addFolder('/Model/Set 1/Inner')
  t.addFile('/Other/x.jpg', 10)
})

afterEach(async () => {
  await fake.close()
})

describe('Dropbox traverse', () => {
  it('lists recursively through continue pages with per-folder counts and a cursor', async () => {
    const events = await collect(source().traverse())
    const all = entries(events)
    expect(all[0]).toMatchObject({ isDir: true, name: 'Model', parentPath: null })
    expect(all.filter((e) => !e.isDir)).toHaveLength(7)
    expect(all.some((e) => e.path.lower?.startsWith('/other'))).toBe(false)
    const dirs = events.filter((e) => e.type === 'dir')
    expect(dirs.map((d) => d.type === 'dir' && [d.path.relative, d.children, d.complete])).toEqual([
      ['', 3, true],
      ['Set 1', 6, true],
      ['Set 1/Inner', 0, true],
    ])
    const end = endOf(events)
    expect(end).toMatchObject({ complete: true, files: 7, dirs: 3, incompleteDirs: 0 })
    expect(end.cursor).toEqual(expect.any(String))
    // 10 entries (folder itself included by Dropbox) with limit 3: one call + 3 continues.
    expect(fake.calls('files/list_folder')).toHaveLength(1)
    expect(fake.calls('files/list_folder/continue')).toHaveLength(3)
    expect(JSON.parse(fake.calls('files/list_folder')[0]?.body ?? '{}')).toMatchObject({
      path: '/Model',
      recursive: true,
      limit: 3,
    })
  })

  it('maps id, rev, content_hash, times and keeps path_display beside path_lower', async () => {
    fake.tree.addFile('/Model/MixedCase.MOV', 50)
    const all = entries(await collect(source().traverse()))
    const clip = all.find((e) => e.name === 'MixedCase.MOV') as SourceEntry
    const node = fake.tree.get('/model/mixedcase.mov')
    expect(clip).toMatchObject({
      source: 'dropbox',
      id: node?.id,
      rev: node?.rev,
      size: 50,
      contentHash: dropboxContentHash(node?.bytes as Buffer),
      md5: null,
      sha256: null,
      mediaType: 'video',
      parentPath: '/Model',
      path: {
        raw: '/Model/MixedCase.MOV',
        lower: '/model/mixedcase.mov',
        relative: 'MixedCase.MOV',
      },
    })
    expect(clip.createdAt).toBe(node?.modified.toISOString())
  })

  it('a cursor reset mid-pass leaves the pass incomplete without a cursor', async () => {
    fake.beforeReply = (req) => {
      if (req.endpoint === 'files/list_folder/continue') fake.resetCursors()
    }
    const events = await collect(source().traverse())
    expect(endOf(events)).toMatchObject({ complete: false, cursor: null })
    expect(
      events.filter((e) => e.type === 'dir').every((d) => d.type === 'dir' && !d.complete),
    ).toBe(true)
  })

  it('a rejected token stops the pass', async () => {
    fake.beforeReply = (req) => {
      if (req.endpoint === 'files/list_folder/continue') fake.token = 'rotated'
    }
    expect((await rejection(collect(source().traverse()))).kind).toBe('auth_rejected')
  })
})

describe('Dropbox recent', () => {
  it('starts from get_latest_cursor with a full traversal, then follows changes', async () => {
    const src = source({ pageSize: 2000 })
    const first = await src.recent(null)
    expect(first).toMatchObject({ fullTraversal: true, entries: [] })
    expect(fake.calls('files/list_folder/get_latest_cursor')).toHaveLength(1)

    fake.tree.addFile('/Model/new.jpg', 10)
    fake.tree.move('/Model/a.jpg', '/Model/Set 1/a.jpg')
    fake.tree.remove('/Model/b.mp4')
    fake.tree.addFile('/Other/y.jpg', 10)
    const second = await src.recent(first.cursor)
    expect(second.fullTraversal).toBe(false)
    expect(second.entries.map((e) => e.path.relative).sort()).toEqual(['Set 1/a.jpg', 'new.jpg'])
    expect(second.deleted.map((d) => d.lower).sort()).toEqual(['/model/a.jpg', '/model/b.mp4'])
    const moved = second.entries.find((e) => e.name === 'a.jpg')
    expect(moved?.id).toBe(fake.tree.get('/Model/Set 1/a.jpg')?.id)

    const third = await src.recent(second.cursor)
    expect(third).toMatchObject({ entries: [], deleted: [], fullTraversal: false })
  })

  it('pages changes until has_more is false', async () => {
    const src = source({ pageSize: 2 })
    const { cursor } = await src.recent(null)
    for (let i = 0; i < 5; i++) fake.tree.addFile(`/Model/n${i}.jpg`, 10)
    const r = await src.recent(cursor)
    expect(r.entries).toHaveLength(5)
  })

  it('the cursor from a full traversal continues into recent()', async () => {
    const src = source()
    const end = endOf(await collect(src.traverse()))
    fake.tree.addFile('/Model/after.jpg', 10)
    const r = await src.recent(end.cursor)
    expect(r.entries.map((e) => e.name)).toEqual(['after.jpg'])
  })

  it('reset: a new cursor and a full traversal now', async () => {
    const src = source()
    const { cursor } = await src.recent(null)
    fake.resetCursors()
    const r = await src.recent(cursor)
    expect(r.fullTraversal).toBe(true)
    expect(r.cursor).not.toBe(cursor)
    expect(fake.calls('files/list_folder/get_latest_cursor')).toHaveLength(2)
  })
})

describe('Dropbox metadata, thumbnails and space', () => {
  it('stats by id after a move and reads media_info', async () => {
    const src = source()
    const before = await src.stat({ path: '/Model/a.jpg' })
    expect(before.shotAt).toBe('2026-09-01T12:00:00.000Z')
    fake.tree.move('/Model/a.jpg', '/Model/Set 1/renamed.jpg')
    const after = await src.stat({ id: before.id as string })
    expect(after.path.relative).toBe('Set 1/renamed.jpg')
    expect((await rejection(src.stat({ path: '/Model/a.jpg' }))).kind).toBe('not_found')
  })

  it('asks get_thumbnail_v2 and treats unsupported files as no picture', async () => {
    fake.tree.addFile('/Model/notes.txt', 10)
    const src = source()
    const photo = await src.stat({ path: '/Model/a.jpg' })
    const thumb = await src.thumbnail(photo, { size: 'w256h256' })
    expect(Buffer.from(thumb?.bytes ?? []).toString()).toBe(`fake-thumbnail:${photo.id}:w256h256`)
    expect(await src.thumbnail(await src.stat({ path: '/Model/notes.txt' }))).toBeNull()
  })

  it('space: individual and team allocations, line from 90 %', async () => {
    fake.allocated = 1000
    fake.used = 950
    expect(await source().space()).toMatchObject({
      totalBytes: 1000,
      usedBytes: 950,
      nearlyFull: true,
    })
    fake.team = true
    fake.used = 100
    expect(await source().space()).toMatchObject({
      totalBytes: 1000,
      usedBytes: 100,
      nearlyFull: false,
    })
  })

  it('escapes non-ASCII in Dropbox-API-Arg', async () => {
    expect(headerJson({ path: '/Модель/é' })).toBe(
      '{"path":"/\\u041c\\u043e\\u0434\\u0435\\u043b\\u044c/\\u00e9"}',
    )
    fake.tree.addFile('/Model/Йога.jpg', 20)
    const src = source()
    const e = await src.stat({ path: '/Model/Йога.jpg' })
    const thumb = await src.thumbnail(e)
    expect(thumb).not.toBeNull()
    const arg = fake.calls('files/get_thumbnail_v2').at(-1)?.headers['dropbox-api-arg'] as string
    expect(/^[\x20-\x7e]*$/.test(arg)).toBe(true)
  })
})

describe('Dropbox tokens and failures', () => {
  it('refreshes an expired short-lived token once and goes on', async () => {
    await fake.close()
    fake = await startFakeDropbox({ refresh: { refreshToken: 'refresh-1', appKey: 'app' } })
    fake.tree.addFolder('/Model')
    const token = dropboxRefreshToken({
      refreshToken: 'refresh-1',
      appKey: 'app',
      apiBase: fake.url,
    })
    const src = createDropboxSource({
      token,
      root: '/Model',
      apiBase: fake.url,
      contentBase: fake.url,
    })
    await src.space()
    expect(fake.calls('oauth2/token')).toHaveLength(1)
    await src.space()
    expect(fake.calls('oauth2/token')).toHaveLength(1)
    fake.expireToken()
    await src.space()
    expect(fake.calls('oauth2/token')).toHaveLength(2)
  })

  it('a bad refresh token is an auth rejection', async () => {
    const token = dropboxRefreshToken({ refreshToken: 'wrong', appKey: 'app', apiBase: fake.url })
    const src = createDropboxSource({
      token,
      root: '/Model',
      apiBase: fake.url,
      contentBase: fake.url,
    })
    expect((await rejection(src.space())).kind).toBe('auth_rejected')
  })

  it('401 stops at once; 429 honours retry_after; malformed JSON is not retried', async () => {
    const src = source()
    fake.token = 'rotated'
    expect((await rejection(src.space())).kind).toBe('auth_rejected')
    expect(fake.calls('users/get_space_usage')).toHaveLength(1)

    fake.fail('rate_limit', { endpoint: 'users/get_space_usage', retryAfter: 2 })
    expect((await source().space()).totalBytes).toBeGreaterThan(0)
    expect(delays[0]).toBeGreaterThanOrEqual(2000)

    fake.fail('malformed', { endpoint: 'files/get_metadata' })
    expect((await rejection(source().stat({ path: '/Model/a.jpg' }))).kind).toBe('bad_response')
    expect(fake.calls('files/get_metadata')).toHaveLength(1)
  })

  it('5xx and cut answers are retried', async () => {
    fake
      .fail('server_error', { endpoint: 'files/list_folder' })
      .fail('cut', { endpoint: 'files/list_folder' })
    const end = endOf(await collect(source().traverse()))
    expect(end.complete).toBe(true)
    expect(fake.calls('files/list_folder')).toHaveLength(3)
    expect(delays).toHaveLength(2)
  })
})
