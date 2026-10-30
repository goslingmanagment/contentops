import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSourceError, type SourceError } from './errors.ts'
import {
  type FakeYandexDisk,
  recordingRetry,
  sha256Hex,
  startFakeYandexDisk,
} from './testing/index.ts'
import type { CloudSource, SourceEntry, TraverseEvent } from './types.ts'
import { createYandexDiskSource } from './yandex-disk.ts'

let fake: FakeYandexDisk
let delays: number[]

function source(
  o: {
    pageSize?: number
    recentLimit?: number
    root?: string
    attempts?: number
    maxDelayMs?: number
  } = {},
): CloudSource {
  const retry = recordingRetry({
    ...(o.attempts ? { attempts: o.attempts } : {}),
    ...(o.maxDelayMs ? { maxDelayMs: o.maxDelayMs } : {}),
  })
  delays = retry.delays
  return createYandexDiskSource({
    token: fake.token,
    root: o.root ?? 'disk:/Model',
    apiBase: fake.url,
    retry: retry.policy,
    pageSize: o.pageSize ?? 3,
    recentLimit: o.recentLimit ?? 5,
  })
}

async function collect(it: AsyncIterable<TraverseEvent>): Promise<TraverseEvent[]> {
  const out: TraverseEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const entries = (events: TraverseEvent[]) =>
  events.flatMap((e) => (e.type === 'entry' ? [e.entry] : []))
const dirEvents = (events: TraverseEvent[]) => events.filter((e) => e.type === 'dir')
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
  fake = await startFakeYandexDisk()
  const t = fake.tree
  t.addFile('/Model/a.jpg', 1000, { shotAt: new Date('2026-09-01T12:00:00Z') })
  t.addFile('/Model/b.mp4', 2000)
  for (let i = 0; i < 7; i++) t.addFile(`/Model/Set 1/${String(i).padStart(2, '0')}.heic`, 100 + i)
  t.addFolder('/Model/Empty')
  t.addFile('/Other model/x.jpg', 10)
})

afterEach(async () => {
  await fake.close()
})

describe('Yandex Disk traverse', () => {
  it('pages every folder and reports each listing as complete', async () => {
    const events = await collect(source().traverse())
    const all = entries(events)
    expect(all[0]?.path.raw).toBe('disk:/Model')
    expect(all[0]?.parentPath).toBeNull()
    expect(all.filter((e) => !e.isDir)).toHaveLength(9)
    expect(all.some((e) => e.path.raw.startsWith('disk:/Other model'))).toBe(false)

    const dirs = dirEvents(events)
    expect(dirs.map((d) => d.type === 'dir' && [d.path.relative, d.children, d.complete])).toEqual([
      ['', 4, true],
      ['Empty', 0, true],
      ['Set 1', 7, true],
    ])
    expect(endOf(events)).toMatchObject({ complete: true, files: 9, dirs: 3, incompleteDirs: 0 })
    // 7 children with limit 3: offsets 0, 3, 6.
    const setPages = fake
      .calls('/v1/disk/resources')
      .filter((r) => r.query.get('path') === 'disk:/Model/Set 1')
    expect(setPages.map((r) => r.query.get('offset'))).toEqual(['0', '3', '6'])
  })

  it('maps the metadata the snapshot needs', async () => {
    const all = entries(await collect(source().traverse()))
    const photo = all.find((e) => e.name === 'a.jpg') as SourceEntry
    const node = fake.tree.get('/Model/a.jpg')
    expect(photo).toMatchObject({
      source: 'yandex_disk',
      id: node?.id,
      isDir: false,
      size: 1000,
      sha256: sha256Hex(node?.bytes as Buffer),
      mediaType: 'image',
      mimeType: 'image/jpeg',
      shotAt: '2026-09-01T12:00:00.000Z',
      parentPath: 'disk:/Model',
      path: { raw: 'disk:/Model/a.jpg', relative: 'a.jpg', lower: null },
    })
    expect(photo.md5).toMatch(/^[0-9a-f]{32}$/)
    expect(photo.createdAt).toBe(node?.created.toISOString())
    expect(photo.previewUrl).toContain('/preview/')
    const fields = fake.calls('/v1/disk/resources')[0]?.query.get('fields') ?? ''
    for (const f of [
      'resource_id',
      'md5',
      'sha256',
      'size',
      'created',
      'modified',
      'exif',
      'media_type',
      'preview',
    ]) {
      expect(fields).toContain(`_embedded.items.${f}`)
    }
  })

  it('restarts a folder listing that changes between pages', async () => {
    let added = false
    fake.beforeReply = (req) => {
      if (
        !added &&
        req.query.get('path') === 'disk:/Model/Set 1' &&
        req.query.get('offset') === '3'
      ) {
        added = true
        fake.tree.addFile('/Model/Set 1/new.heic', 5)
      }
    }
    const events = await collect(source().traverse())
    const set = dirEvents(events).find((d) => d.type === 'dir' && d.path.relative === 'Set 1')
    expect(set).toMatchObject({ complete: true, children: 8 })
  })

  it('marks a folder incomplete when it keeps changing, and the pass with it', async () => {
    let n = 0
    fake.beforeReply = (req) => {
      if (req.query.get('path') === 'disk:/Model/Set 1' && req.query.get('offset') === '3') {
        fake.tree.addFile(`/Model/Set 1/more-${n++}.heic`, 5)
      }
    }
    const events = await collect(source().traverse())
    const set = dirEvents(events).find((d) => d.type === 'dir' && d.path.relative === 'Set 1')
    expect(set).toMatchObject({ complete: false, reason: 'changed_while_listing' })
    expect(endOf(events)).toMatchObject({ complete: false, incompleteDirs: 1 })
  })

  it('a folder gone mid-pass marks only itself incomplete', async () => {
    fake.beforeReply = (req) => {
      if (req.query.get('path') === 'disk:/Model/Empty') fake.tree.remove('/Model/Empty')
    }
    const events = await collect(source().traverse())
    const gone = dirEvents(events).find((d) => d.type === 'dir' && d.path.relative === 'Empty')
    expect(gone).toMatchObject({ complete: false, reason: 'not_found', id: expect.any(String) })
    expect(endOf(events)).toMatchObject({ complete: false, incompleteDirs: 1, files: 9 })
  })

  it('a missing root stops the pass', async () => {
    const err = await rejection(collect(source({ root: 'disk:/Nope' }).traverse()))
    expect(err.kind).toBe('not_found')
  })
})

describe('Yandex Disk recent', () => {
  it('first run asks for a full traversal and returns a watermark', async () => {
    const r = await source({ recentLimit: 50 }).recent(null)
    expect(r.fullTraversal).toBe(true)
    expect(r.entries.every((e) => e.path.raw.startsWith('disk:/Model/'))).toBe(true)
    expect(r.entries).toHaveLength(9)
    expect(fake.calls('/v1/disk/resources/last-uploaded')[0]?.query.get('limit')).toBe('50')
    const newest = Math.max(...fake.tree.files().map((f) => f.created.getTime()))
    expect(r.cursor).toBe(new Date(newest).toISOString())
  })

  it('a full page that does not reach the last scan means a full traversal now', async () => {
    const src = source({ recentLimit: 5 })
    const first = await src.recent(null)
    // Fewer new files than the limit: the page reaches back to the watermark.
    fake.tree.addFile('/Model/new 1.jpg', 10)
    const second = await src.recent(first.cursor)
    expect(second.fullTraversal).toBe(false)
    expect(second.entries.map((e) => e.name)).toContain('new 1.jpg')
    // More new files than the limit: something may be missing.
    for (let i = 0; i < 6; i++) fake.tree.addFile(`/Model/burst ${i}.jpg`, 10)
    const third = await src.recent(second.cursor)
    expect(third.fullTraversal).toBe(true)
    expect(third.cursor > second.cursor).toBe(true)
  })
})

describe('Yandex Disk metadata, previews and space', () => {
  it('stats by path and refuses an id-only lookup', async () => {
    const src = source()
    const e = await src.stat({ path: '/Model/b.mp4' })
    expect(e).toMatchObject({ name: 'b.mp4', size: 2000, mediaType: 'video' })
    await expect(src.stat({ id: e.id as string })).rejects.toThrow(TypeError)
    expect((await rejection(src.stat({ path: '/Model/none' }))).kind).toBe('not_found')
  })

  it('fetches the preview with the token and the asked size', async () => {
    const src = source()
    const photo = await src.stat({ path: 'disk:/Model/a.jpg' })
    const thumb = await src.thumbnail(photo, { size: 'M' })
    expect(Buffer.from(thumb?.bytes ?? []).toString()).toBe(`fake-preview:${photo.id}:M`)
    expect(fake.calls('preview')[0]?.headers.authorization).toBe(`OAuth ${fake.token}`)
    const dir = await src.stat({ path: 'disk:/Model/Empty' })
    expect(await src.thumbnail(dir)).toBeNull()
  })

  it('an expired preview link is renewed once through the metadata', async () => {
    const src = source()
    const photo = await src.stat({ path: 'disk:/Model/a.jpg' })
    const stale = { ...photo, previewUrl: `${fake.url}/preview/stale-link?size=S` }
    const thumb = await src.thumbnail(stale)
    expect(Buffer.from(thumb?.bytes ?? []).toString()).toBe(`fake-preview:${photo.id}:XL`)
    expect(fake.calls('preview')).toHaveLength(2)
  })

  it('space shows the line from 90 %', async () => {
    fake.totalSpace = 1000
    fake.usedSpace = 899
    expect(await source().space()).toMatchObject({
      totalBytes: 1000,
      usedBytes: 899,
      nearlyFull: false,
    })
    fake.usedSpace = 900
    expect(await source().space()).toMatchObject({ usedRatio: 0.9, nearlyFull: true })
  })
})

describe('Yandex Disk paths', () => {
  it('keeps `:`, trailing spaces and NFD names raw, with NFC beside', async () => {
    const nfd = 'Йога'.normalize('NFD')
    fake.tree.addFile(`/Model/Trip /10:32 ${nfd}.mp4`, 300)
    const src = source()
    const all = entries(await collect(src.traverse()))
    const clip = all.find((e) => e.name.startsWith('10:32')) as SourceEntry
    expect(clip.path.raw).toBe(`disk:/Model/Trip /10:32 ${nfd}.mp4`)
    expect(clip.path.nfc).toBe('disk:/Model/Trip /10:32 Йога.mp4')
    expect(clip.path.relative).toBe(`Trip /10:32 ${nfd}.mp4`)
    expect(clip.path.relativeNfc).toBe('Trip /10:32 Йога.mp4')
    expect(clip.parentPath).toBe('disk:/Model/Trip ')
    expect(all.find((e) => e.isDir && e.name === 'Trip ')).toBeTruthy()
    const again = await src.stat({ path: clip.path.raw })
    expect(again.id).toBe(clip.id)
  })
})

describe('Yandex Disk failures', () => {
  it('429 waits at least Retry-After, then succeeds', async () => {
    fake.fail('rate_limit', { endpoint: '/v1/disk', times: 2, retryAfter: 3 })
    const space = await source().space()
    expect(space.totalBytes).toBeGreaterThan(0)
    expect(fake.calls('/v1/disk')).toHaveLength(3)
    expect(delays).toHaveLength(2)
    for (const d of delays) expect(d).toBeGreaterThanOrEqual(3000)
  })

  it('a Retry-After beyond the policy goes to the caller', async () => {
    fake.fail('rate_limit', { endpoint: '/v1/disk', retryAfter: 600 })
    const err = await rejection(source({ maxDelayMs: 60_000 }).space())
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 600_000 })
    expect(fake.calls('/v1/disk')).toHaveLength(1)
  })

  it('401 stops at once with the time of rejection', async () => {
    const src = source()
    fake.token = 'rotated'
    const before = Date.now()
    const err = await rejection(src.space())
    expect(err.kind).toBe('auth_rejected')
    expect(err.status).toBe(401)
    expect(err.at.getTime()).toBeGreaterThanOrEqual(before)
    expect(fake.calls('/v1/disk')).toHaveLength(1)
  })

  it('403 is an auth rejection too', async () => {
    fake.fail('forbidden', { endpoint: '/v1/disk' })
    expect((await rejection(source().space())).kind).toBe('auth_rejected')
  })

  it('5xx and a cut answer are retried; attempts are bounded', async () => {
    fake.fail('server_error', { endpoint: '/v1/disk' }).fail('cut', { endpoint: '/v1/disk' })
    expect((await source().space()).totalBytes).toBeGreaterThan(0)
    expect(fake.calls('/v1/disk')).toHaveLength(3)

    fake.fail('server_error', { endpoint: '/v1/disk', times: 10 })
    const err = await rejection(source({ attempts: 3 }).space())
    expect(err.kind).toBe('transient')
    expect(fake.calls('/v1/disk')).toHaveLength(6)
  })

  it('malformed JSON is a bad response, not retried', async () => {
    fake.fail('malformed', { endpoint: '/v1/disk/resources/last-uploaded' })
    const err = await rejection(source().recent(null))
    expect(err.kind).toBe('bad_response')
    expect(fake.calls('/v1/disk/resources/last-uploaded')).toHaveLength(1)
  })

  it('a rejected token mid-pass stops the traversal', async () => {
    fake.beforeReply = (req) => {
      if (req.query.get('path') === 'disk:/Model/Set 1') fake.token = 'rotated'
    }
    const err = await rejection(collect(source().traverse()))
    expect(err.kind).toBe('auth_rejected')
  })
})
