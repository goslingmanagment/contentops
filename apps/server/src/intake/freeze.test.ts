import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { DROPBOX_ENDPOINTS, YANDEX_DISK_ENDPOINTS } from '@contentops/sources'
import { fakeBytes, MALFORMED_JSON } from '@contentops/sources/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeZip } from '../media/zip'
import { enqueueFreeze, type FreezeReport, freezeRegister } from './freeze'
import { scanHandler } from './scan'
import {
  type IntakeHarness,
  intakeCounts,
  intakeHarness,
  LORA_ROOT,
  runWork,
  setSwitch,
} from './testing'

/** SPEC §6.3, PLAN 2в: the snapshot `scan:freeze` of a source, with the fakes only. */

let h: IntakeHarness
let scratch: string
const day = (iso: string) => new Date(iso)

/** A stored ZIP of members with fixed bytes, built by the issue writer (`media/zip.ts`). */
async function zipOf(members: Record<string, Buffer>): Promise<Buffer> {
  const dir = await mkdtemp(join(scratch, 'zip-'))
  const files = await Promise.all(
    Object.entries(members).map(async ([name, bytes], n) => {
      const path = join(dir, String(n))
      await writeFile(path, bytes)
      return { name, path }
    }),
  )
  await writeZip(join(dir, 'out.zip'), files)
  return readFile(join(dir, 'out.zip'))
}

const PHOTO_1 = fakeBytes(150_000, 'photo-1')
const PHOTO_2 = fakeBytes(150_000, 'photo-2')
const NOTE = Buffer.from('a list of shots\n')

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'freeze-'))
  h = await intakeHarness({ pageSize: 3 })
  await setSwitch(h.db, 'ydisk.scan', h.modelId, true)
  await setSwitch(h.db, 'dropbox.scan', h.modelId, true)
  const t = h.yandex.tree
  t.addFile(`${LORA_ROOT}/1. PPV/Bundle 1/master.mp4`, 4000, {
    shotAt: day('2026-08-01T10:00:00Z'),
  })
  t.addFile(`${LORA_ROOT}/1. PPV/Bundle 1/cover.jpg`, 900)
  t.addFile(
    `${LORA_ROOT}/Old/pack.zip`,
    await zipOf({ 'a/01.jpg': PHOTO_1, 'a/02.jpg': PHOTO_2, 'notes.txt': NOTE }),
  )
  t.addFile(`${LORA_ROOT}/Old/broken.zip`, 5000)
  t.addFile(`${LORA_ROOT}/Old/pack.rar`, 3000)
  t.addFile(`${LORA_ROOT}/notes.txt`, 10)
  // Discovery saw the disk before the snapshot: the snapshot reuses its revisions.
  const seen = await runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    scope: h.sources.yandex.id,
    dataset: 'full',
    handlers: { scan: scanHandler(h.factory) },
  })
  expect(seen.state).toBe('succeeded')
})
afterAll(async () => {
  await h?.close()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

async function freeze(source: string, date: string) {
  const queued = await enqueueFreeze(h.db, { model: 'lora', source, date })
  const outcome = await runWork(h.db, {
    modelId: h.modelId,
    kind: 'scan',
    workId: queued.work.id,
    handlers: { scan: scanHandler(h.factory) },
  })
  return { ...outcome, report: outcome.report as FreezeReport | null, created: queued.created }
}

async function pinnedBy(workId: string) {
  const { rows } = await h.db.execute<{ id: string; path: string; member: boolean }>(sql`
    SELECT r.id, r.frozen_path AS path, o.archive_revision_id IS NOT NULL AS member
      FROM source_revisions r
      JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
     WHERE r.frozen_by_work_id = ${workId}::uuid ORDER BY r.frozen_path`)
  return rows
}

async function cases() {
  const { rows } = await h.db.execute<{ dedup_key: string; reason: string; title: string }>(sql`
    SELECT dedup_key, details ->> 'reason' AS reason, details ->> 'title' AS title
      FROM review_cases WHERE kind = 'unreadable_input' ORDER BY dedup_key`)
  return rows
}

describe('the snapshot of Yandex Disk', () => {
  let first: Awaited<ReturnType<typeof freeze>>

  it('a complete pass reuses observed revisions, pins them and records completeness', async () => {
    const before = await intakeCounts(h.db)
    first = await freeze('Я.Диск', '2026-11-02')
    expect(first.state).toBe('succeeded')
    expect(first.report).toMatchObject({
      mode: 'freeze',
      date: '2026-11-02',
      files: 6,
      // Every file was seen by discovery: none is new.
      revisions: 0,
      incomplete_dirs: [],
      archives: 3,
      archives_read: 1,
      members: 3,
      // Two archives without a table of contents: incomplete input, not a block.
      complete: false,
      pinned: 9,
      pinned_before: 0,
    })
    expect(first.report?.dirs).toBe(first.report?.dirs_complete)
    expect(first.report?.dirs).toBe(4) // the model's folder, 1. PPV, Bundle 1, Old
    const pinned = await pinnedBy(first.id)
    expect(
      pinned
        .filter((row) => !row.member)
        .map((row) => row.path)
        .sort(),
    ).toEqual([
      `disk:${LORA_ROOT}/1. PPV/Bundle 1/cover.jpg`,
      `disk:${LORA_ROOT}/1. PPV/Bundle 1/master.mp4`,
      `disk:${LORA_ROOT}/Old/broken.zip`,
      `disk:${LORA_ROOT}/Old/pack.rar`,
      `disk:${LORA_ROOT}/Old/pack.zip`,
      `disk:${LORA_ROOT}/notes.txt`,
    ])
    // The snapshot is metadata: no group, no draft, no byte.
    const after = await intakeCounts(h.db)
    expect([after.groups, after.drafts]).toEqual([before.groups, before.drafts])
    const { rows } = await h.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM blobs`)
    expect(rows[0]?.n).toBe(0)
    // Shooting time and type come with the revision.
    const { rows: master } = await h.db.execute<{ shot: string; media: string }>(sql`
      SELECT r.remote_shot_at::text AS shot, r.media_type AS media
        FROM source_revisions r JOIN source_objects o ON o.id = r.source_object_id
       WHERE o.current_name = 'master.mp4'`)
    expect(master[0]).toEqual({ shot: '2026-08-01 10:00:00+00', media: 'video' })
  })

  it("a zip's table of contents is recorded without unpacking", async () => {
    const { rows } = await h.db.execute<{
      entry_no: number
      path: string
      size: string
      crc: string
      media: string | null
      archive: string
    }>(sql`
      SELECT o.archive_entry_no AS entry_no, o.current_path AS path, r.byte_size::text AS size,
             encode(r.crc32, 'hex') AS crc, r.media_type AS media, ao.current_name AS archive
        FROM source_objects o
        JOIN source_revisions r ON r.model_id = o.model_id AND r.id = o.current_revision_id
        JOIN source_revisions ar ON ar.id = o.archive_revision_id
        JOIN source_objects ao ON ao.id = ar.source_object_id
       WHERE o.archive_revision_id IS NOT NULL ORDER BY o.archive_entry_no`)
    const hex = (bytes: Buffer) => crc32(bytes).toString(16).padStart(8, '0')
    expect(rows).toEqual([
      {
        entry_no: 0,
        path: `disk:${LORA_ROOT}/Old/pack.zip/a/01.jpg`,
        size: '150000',
        crc: hex(PHOTO_1),
        media: 'image',
        archive: 'pack.zip',
      },
      {
        entry_no: 1,
        path: `disk:${LORA_ROOT}/Old/pack.zip/a/02.jpg`,
        size: '150000',
        crc: hex(PHOTO_2),
        media: 'image',
        archive: 'pack.zip',
      },
      {
        entry_no: 2,
        path: `disk:${LORA_ROOT}/Old/pack.zip/notes.txt`,
        size: String(NOTE.length),
        crc: hex(NOTE),
        media: null,
        archive: 'pack.zip',
      },
    ])
    // Only the tail of the archive was asked for, with a Range start.
    const zipId = h.yandex.tree.get(`${LORA_ROOT}/Old/pack.zip`)?.id
    const reads = h.yandex
      .calls('download')
      .filter((req) => req.path.endsWith(encodeURIComponent(zipId ?? '')))
    expect(reads).toHaveLength(1)
    expect(reads[0]?.headers.range).toMatch(/^bytes=[1-9]\d*-$/)
  })

  it('an unreadable archive opens unreadable_input once', async () => {
    expect(first.report?.unreadable_archives).toEqual([
      { path: `disk:${LORA_ROOT}/Old/broken.zip`, reason: 'not_zip' },
      { path: `disk:${LORA_ROOT}/Old/pack.rar`, reason: 'format:rar' },
    ])
    const opened = await cases()
    expect(opened.map((row) => [row.reason, row.title])).toEqual([
      ['not_zip', 'Архив не читается'],
      ['format:rar', 'Архив не читается'],
    ])
    expect(opened.every((row) => row.dedup_key.startsWith('archive:'))).toBe(true)
  })

  it('the same date is one work; another source cannot take it', async () => {
    const again = await freeze('Я.Диск', '2026-11-02')
    expect(again).toMatchObject({ id: first.id, created: false, state: 'succeeded' })
    await expect(
      enqueueFreeze(h.db, { model: 'lora', source: 'Dropbox', date: '2026-11-02' }),
    ).rejects.toThrow(/другого источника/)
  })

  it('an interrupted or partial pass pins nothing; the retry pins', async () => {
    h.yandex.tree.addFile(`${LORA_ROOT}/1. PPV/Bundle 2/master.mp4`, 4100)
    // Four files: two pages of three.
    const busy = `${LORA_ROOT}/Busy`
    for (let n = 1; n <= 4; n++) h.yandex.tree.addFile(`${busy}/${n}.jpg`, 200 + n)
    // The pass breaks off mid-way: the source keeps failing after a few listings.
    let listings = 0
    h.yandex.beforeReply = (req) => {
      if (req.endpoint === '/v1/disk/resources' && ++listings === 3) {
        h.yandex.fail('server_error', { times: 20 })
      }
    }
    const broken = await freeze('Я.Диск', '2026-11-03')
    h.yandex.beforeReply = null
    h.yandex.clearFailures()
    expect(broken).toMatchObject({ state: 'retry_wait', error_code: 'transient' })
    expect(await pinnedBy(broken.id)).toEqual([])

    // A folder that keeps changing while it is listed: the pass is not a snapshot either.
    let added = 0
    h.yandex.beforeReply = (req) => {
      if (req.query.get('path') === `disk:${busy}` && req.query.get('offset') === '3') {
        h.yandex.tree.addFile(`${busy}/extra-${++added}.jpg`, 100 + added)
      }
    }
    await h.db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now(), error_code = NULL WHERE id = ${broken.id}::uuid`,
    )
    const partial = await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      workId: broken.id,
      handlers: { scan: scanHandler(h.factory) },
    })
    h.yandex.beforeReply = null
    expect(partial).toMatchObject({ state: 'retry_wait', error_code: 'listing_incomplete' })
    expect(await pinnedBy(broken.id)).toEqual([])

    await h.db.execute(
      sql`UPDATE work_operations SET next_attempt_at = now(), error_code = NULL WHERE id = ${broken.id}::uuid`,
    )
    const done = await runWork(h.db, {
      modelId: h.modelId,
      kind: 'scan',
      workId: broken.id,
      handlers: { scan: scanHandler(h.factory) },
    })
    expect(done.state).toBe('succeeded')
    // Only what the first snapshot had not pinned: the new master and the busy folder.
    expect(added).toBeGreaterThan(0)
    const pinned = await pinnedBy(broken.id)
    expect(pinned.map((row) => row.path.slice(row.path.lastIndexOf('/') + 1)).sort()).toEqual(
      [
        'master.mp4',
        ...['1', '2', '3', '4'].map((n) => `${n}.jpg`),
        ...Array.from({ length: added }, (_, n) => `extra-${n + 1}.jpg`),
      ].sort(),
    )
    expect(done.report).toMatchObject({ pinned: pinned.length, pinned_before: 9 })
  })

  it('a changed file gets the next revision, the old one keeps its snapshot', async () => {
    h.yandex.tree.replace(`${LORA_ROOT}/1. PPV/Bundle 1/cover.jpg`, 950)
    const second = await freeze('Я.Диск', '2026-11-04')
    expect(second.report).toMatchObject({ revisions: 1, pinned: 1 })
    const { rows } = await h.db.execute<{ sequence_no: number; frozen: string }>(sql`
      SELECT r.sequence_no, r.frozen_by_work_id AS frozen
        FROM source_revisions r JOIN source_objects o ON o.id = r.source_object_id
       WHERE o.current_name = 'cover.jpg' ORDER BY r.sequence_no`)
    expect(rows).toEqual([
      { sequence_no: 1, frozen: first.id },
      { sequence_no: 2, frozen: second.id },
    ])
  })

  it('a folder whose listing is unreadable is incomplete input, the snapshot still pins', async () => {
    h.yandex.tree.addFile(`${LORA_ROOT}/Broken/x.jpg`, 500)
    const fake = h.yandex as unknown as {
      handle: (req: { endpoint: string; query: URLSearchParams }) => unknown
    }
    const handle = fake.handle.bind(h.yandex)
    fake.handle = (req) =>
      req.endpoint === '/v1/disk/resources' && req.query.get('path') === `disk:${LORA_ROOT}/Broken`
        ? { status: 200, body: MALFORMED_JSON }
        : handle(req)
    const run = await freeze('Я.Диск', '2026-11-05')
    fake.handle = handle
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({
      complete: false,
      incomplete_dirs: [{ path: `disk:${LORA_ROOT}/Broken`, reason: 'bad_response' }],
    })
    expect(run.report?.dirs_complete).toBe((run.report?.dirs ?? 0) - 1)
    expect((await cases()).filter((row) => row.dedup_key.startsWith('dir:'))).toEqual([
      expect.objectContaining({ reason: 'bad_response', title: 'Каталог не читается' }),
    ])
  })

  it('the export lists exactly the pinned revisions', async () => {
    const lines: Record<string, unknown>[] = []
    for await (const line of freezeRegister(h.db, { model: 'lora', date: '2026-11-02' })) {
      lines.push(line)
    }
    const [header, ...register] = lines
    expect(header).toMatchObject({ kind: 'snapshot', work_id: first.id, source: 'Я.Диск' })
    const pinned = await pinnedBy(first.id)
    expect(register.map((line) => line.revision_id).sort()).toEqual(
      pinned.map((row) => row.id).sort(),
    )
    const master = register.find((line) => String(line.path).endsWith('master.mp4'))
    expect(master).toMatchObject({
      kind: 'file',
      resource_id: expect.any(String),
      md5: expect.stringMatching(/^[0-9a-f]{32}$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      size: 4000,
      shot_at: '2026-08-01T10:00:00.000Z',
      media_type: 'video',
    })
    const member = register.find((line) => line.kind === 'member')
    expect(member).toMatchObject({
      archive_resource_id: h.yandex.tree.get(`${LORA_ROOT}/Old/pack.zip`)?.id,
      entry_no: 0,
      size: 150_000,
      crc32: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  })

  it('Yandex Disk saw only read endpoints', () => {
    const allowed = new Set<string>([...YANDEX_DISK_ENDPOINTS, 'download', 'preview'])
    expect(
      h.yandex.requests.filter((req) => req.method !== 'GET' || !allowed.has(req.endpoint)),
    ).toEqual([])
  })
})

describe('the snapshot of Dropbox', () => {
  it('reads a zip pinned to its rev and only read endpoints', async () => {
    const t = h.dropbox.tree
    t.addFile(`${LORA_ROOT}/2. Sets/Set A/01.jpg`, 1000)
    t.addFile(`${LORA_ROOT}/Archive/old.zip`, await zipOf({ '01.jpg': PHOTO_1, '02.jpg': PHOTO_2 }))
    const before = await intakeCounts(h.db)
    const run = await freeze('Dropbox', '2026-11-06')
    expect(run.state).toBe('succeeded')
    expect(run.report).toMatchObject({
      files: 2,
      archives_read: 1,
      members: 2,
      pinned: 4,
      complete: true,
    })
    const after = await intakeCounts(h.db)
    expect([after.groups, after.drafts]).toEqual([before.groups, before.drafts])
    const downloads = h.dropbox.calls('files/download')
    expect(downloads.length).toBeGreaterThan(0)
    expect(
      downloads.every((req) => /"path":"rev:/.test(req.headers['dropbox-api-arg'] as string)),
    ).toBe(true)
    const allowed = new Set<string>(DROPBOX_ENDPOINTS)
    expect(h.dropbox.requests.filter((req) => !allowed.has(req.endpoint))).toEqual([])
  })
})
