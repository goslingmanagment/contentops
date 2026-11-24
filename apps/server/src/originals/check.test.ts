import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Db, enqueueWork, type WorkContext, type WorkRow, WorkRunner } from '@contentops/db'
import { dropboxContentHash } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { instant } from '../commands'
import { systemTx } from '../media/testing'
import { type TestServer, testServer } from '../testing/server'
import { createWorkGate } from '../work-gate'
import { type AuditReport, originalsAuditHandler } from './audit'
import { type CheckOptions, type CheckReport, originalsCheckHandler } from './check'
import { MODEL_CONFIG_KEY } from './config'
import { listedPath, RcloneTransport, servePath } from './rclone'
import { originalStates } from './rule'
import { originalsLine } from './summary'
import { FakeClouds } from './testing'
import { setOriginalsSwitch } from './work'

/**
 * The check of the originals inside ContentOps (SPEC §9.4, migration 0028): a MEGA copy is checked
 * only when its bytes give the original's hashes, with the node it saw; wrong bytes never check
 * it; a node already seen is never downloaded again; the nightly audit marks a copy missing only
 * after two whole listings without it, never after a broken one; the switch holds the works; a
 * stalled stream gives the slot back.
 */

let server: TestServer
let db: Db

beforeAll(async () => {
  server = await testServer()
  db = server.db
  await setOriginalsSwitch(db, true)
})
afterAll(() => server.close())

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest()
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

async function newModel(): Promise<string> {
  return systemTx(db, async (tx) => {
    const code = `m${randomUUID().slice(0, 8)}`
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO models (code, title, title_genitive) VALUES (${code}, ${code}, ${code})
      RETURNING id`)
    return rows[0]?.id as string
  })
}

async function source(model: string, kind: 'yandex_disk' | 'dropbox'): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
      VALUES (${model}::uuid, ${kind}, ${`${kind} ${randomUUID().slice(0, 6)}`},
              ${kind === 'yandex_disk' ? 'disk:/' : ''}, 'TOKEN')
      RETURNING id`)
    return rows[0]?.id as string
  })
}

/** A file of the source with its one revision and the hashes the cloud gave for `bytes`. */
async function file(
  model: string,
  src: string,
  kind: 'yandex_disk' | 'dropbox',
  path: string,
  bytes: Uint8Array,
  options: { verified?: boolean } = {},
): Promise<string> {
  const full = kind === 'yandex_disk' ? `disk:/${path}` : `/${path}`
  const verified = options.verified === true
  return systemTx(db, async (tx) => {
    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      VALUES (${model}::uuid, ${src}::uuid, ${`id:${randomUUID()}`}, ${full},
              ${path.slice(path.lastIndexOf('/') + 1)})
      RETURNING id`)
    const object = objects[0]?.id as string
    const { rows: revisions } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size, md5,
                                    remote_sha256, content_hash, remote_rev, source_sha256,
                                    verified_at, verified_route)
      VALUES (${model}::uuid, ${object}::uuid, 1, ${bytes.length},
              ${kind === 'yandex_disk' ? md5(bytes) : null},
              ${kind === 'yandex_disk' ? sha256(bytes) : null},
              ${kind === 'dropbox' ? Buffer.from(dropboxContentHash(bytes), 'hex') : null},
              ${kind === 'dropbox' ? randomUUID().replaceAll('-', '') : null},
              ${verified ? sha256(bytes) : null}, ${verified ? new Date() : null},
              ${verified ? 'download' : null})
      RETURNING id`)
    const revision = revisions[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${revision}::uuid WHERE id = ${object}::uuid`)
    return revision
  })
}

/** The model is the only one the works look at. */
async function configure(model: string, config: Record<string, unknown>): Promise<void> {
  await systemTx(db, async (tx) => {
    await tx.execute(sql`
      UPDATE policy_settings SET value = NULL WHERE key = ${MODEL_CONFIG_KEY} AND value IS NOT NULL`)
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value)
      VALUES (${model}::uuid, ${MODEL_CONFIG_KEY}, ${JSON.stringify(config)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
  })
}

interface CopyRow {
  id: string
  path: string
  object_ref: string | null
  byte_size: string | null
  seen_md5: string | null
  seen_sha256: string | null
  seen_dropbox: string | null
  verified_at: Date | null
  verified_by: string | null
  attempts: number
  error: string | null
  next_in_min: number | null
  unseen_since: Date | null
  missing_since: Date | null
  last_seen_at: Date | null
}

async function rowOf(revision: string, place: 'yandex' | 'dropbox' | 'mega'): Promise<CopyRow> {
  const { rows } = await db.execute<CopyRow & Record<string, unknown>>(sql`
    SELECT id, path, object_ref, byte_size::text AS byte_size, encode(seen_md5, 'hex') AS seen_md5,
           encode(seen_sha256, 'hex') AS seen_sha256,
           encode(seen_dropbox_hash, 'hex') AS seen_dropbox, verified_at, verified_by, attempts,
           error, extract(epoch FROM next_try_at - now()) / 60 AS next_in_min, unseen_since,
           missing_since, last_seen_at
      FROM original_copies WHERE source_revision_id = ${revision}::uuid AND place = ${place}`)
  const row = rows[0]
  if (!row) throw new Error(`no ${place} row of ${revision}`)
  const at = (value: unknown) => (value === null ? null : new Date(instant(value as string)))
  return {
    ...row,
    verified_at: at(row.verified_at),
    unseen_since: at(row.unseen_since),
    missing_since: at(row.missing_since),
    last_seen_at: at(row.last_seen_at),
    next_in_min: row.next_in_min === null ? null : Number(row.next_in_min),
  }
}

function context(signal = new AbortController().signal): WorkContext {
  return { work: {} as WorkRow, signal, db, checkpoint: async () => {} }
}

async function check(
  clouds: FakeClouds,
  options: Omit<CheckOptions, 'transport'> = {},
): Promise<CheckReport> {
  const result = await originalsCheckHandler({ transport: () => clouds, ...options })(context())
  return result?.report as CheckReport
}

async function audit(clouds: FakeClouds, at: Date): Promise<AuditReport> {
  const result = await originalsAuditHandler({ transport: () => clouds, now: () => at })(context())
  return result?.report as AuditReport
}

/** A model with Я.Диск whose copies the nightly copy puts under `originals/<code>/yadisk`. */
async function yandexModel(extra: Record<string, unknown> = {}) {
  const model = await newModel()
  const src = await source(model, 'yandex_disk')
  const root = `originals/${randomUUID().slice(0, 8)}`
  await configure(model, {
    yandex_disk: 'yadisk:',
    mega: `mega:${root}`,
    copies: { yandex_disk: 'yadisk' },
    ...extra,
  })
  const clouds = new FakeClouds()
  clouds.hashes.set('yadisk', 'md5')
  return { model, src, root, clouds }
}

beforeEach(() => {
  vi.useRealTimers()
})

describe('the check of a MEGA copy', () => {
  it('checks it only when its bytes give the original hashes, and keeps the node it saw', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(300_000)
    const revision = await file(model, src, 'yandex_disk', '1. PPV/a.mov', bytes)
    clouds.put('mega', `${root}/yadisk/1. PPV/a.mov`, { bytes, id: 'NODE-A', modTime: null })

    const report = await check(clouds)

    expect(report).toMatchObject({ checked: 1, verified: 1, mismatched: 0 })
    const copy = await rowOf(revision, 'mega')
    expect(copy).toMatchObject({
      path: `${root}/yadisk/1. PPV/a.mov`,
      object_ref: 'NODE-A',
      byte_size: String(bytes.length),
      verified_by: 'worker:originals',
      seen_md5: hex(md5(bytes)),
      seen_sha256: hex(sha256(bytes)),
      seen_dropbox: dropboxContentHash(bytes),
      error: null,
    })
    expect(copy.verified_at).not.toBeNull()
    expect(clouds.downloads).toHaveLength(1)
    // The origin row is there too, as `seed` makes it.
    expect((await rowOf(revision, 'yandex')).path).toBe('disk:/1. PPV/a.mov')
  })

  it('never checks wrong bytes, and does not download the same node again', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(200_000)
    const wrong = randomBytes(200_000)
    const revision = await file(model, src, 'yandex_disk', 'x/b.mov', bytes)
    clouds.put('mega', `${root}/yadisk/x/b.mov`, { bytes: wrong, id: 'NODE-B' })

    expect(await check(clouds)).toMatchObject({ checked: 1, verified: 0, mismatched: 1 })
    const copy = await rowOf(revision, 'mega')
    expect(copy.verified_at).toBeNull()
    expect(copy.error).toMatch(/^mismatch: /)
    expect(copy.attempts).toBe(1)
    expect(copy.next_in_min).toBeGreaterThan(23 * 60)
    expect(copy.seen_md5).toBe(hex(md5(wrong)))

    // Due again: the node's hashes are known, nothing is downloaded, nothing is checked.
    await db.execute(sql`
      UPDATE original_copies SET next_try_at = now() - interval '1 second' WHERE id = ${copy.id}::uuid`)
    expect(await check(clouds)).toMatchObject({ mismatched: 1, reused: 1, downloaded_bytes: 0 })
    expect((await rowOf(revision, 'mega')).verified_at).toBeNull()
    expect(clouds.downloads).toHaveLength(1)

    // Another size than the original: wrong without a download.
    const other = await file(model, src, 'yandex_disk', 'x/c.mov', bytes)
    clouds.put('mega', `${root}/yadisk/x/c.mov`, { bytes: bytes.subarray(1), id: 'NODE-C' })
    expect(await check(clouds)).toMatchObject({ mismatched: 1, downloaded_bytes: 0 })
    expect(await rowOf(other, 'mega')).toMatchObject({
      verified_at: null,
      error: 'mismatch: size differs',
      object_ref: 'NODE-C',
    })
  })

  it('a checked node and size are never downloaded again, for any row', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(100_000)
    const first = await file(model, src, 'yandex_disk', 'd/one.mov', bytes)
    clouds.put('mega', `${root}/yadisk/d/one.mov`, { bytes, id: 'NODE-D' })
    expect(await check(clouds)).toMatchObject({ verified: 1 })
    expect(await check(clouds)).toMatchObject({ due: 0, checked: 0 })

    // The same bytes under another name in the source, pointing at the same node.
    const twin = await file(model, src, 'yandex_disk', 'd/two.mov', bytes)
    clouds.put('mega', `${root}/yadisk/d/two.mov`, { bytes, id: 'NODE-D' })
    expect(await check(clouds)).toMatchObject({ verified: 1, reused: 1, downloaded_bytes: 0 })
    expect(await rowOf(twin, 'mega')).toMatchObject({ object_ref: 'NODE-D' })
    expect((await rowOf(twin, 'mega')).verified_at).not.toBeNull()
    expect((await rowOf(first, 'mega')).verified_at).not.toBeNull()
    expect(clouds.downloads).toHaveLength(1)
  })

  it('the copy of Я.Диск that frees the PC goes first', async () => {
    const { model, src, root, clouds } = await yandexModel({ pc: ['ydisk_copy'] })
    const decided = randomBytes(50_000)
    const open = randomBytes(50_000)
    // `a/…` comes first by path; the decided one must still go first.
    const later = await file(model, src, 'yandex_disk', 'a/open.mov', open, { verified: true })
    const first = await file(model, src, 'yandex_disk', 'z/decided.mov', decided, {
      verified: true,
    })
    const master = randomBytes(32)
    await systemTx(db, async (tx) => {
      await tx.execute(sql`
        INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key, state)
        VALUES (${master}, 1, 'video/mp4', 'mp4', 'video', ${`blobs/sha256/${hex(master)}.mp4`},
                'present')`)
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO inbox_groups (model_id, source_id, group_key, grouping)
        VALUES (${model}::uuid, ${src}::uuid, ${`g:${randomUUID()}`}, 'folder') RETURNING id`)
      await tx.execute(sql`
        INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, state,
                                  source_sha256, master_sha256, master_verified_at)
        VALUES (${model}::uuid, ${rows[0]?.id}::uuid, ${first}::uuid, 'disk_scan', 'ready',
                ${sha256(decided)}, ${master}, now())`)
    })
    clouds.put('mega', `${root}/yadisk/a/open.mov`, { bytes: open, id: 'N-OPEN' })
    clouds.put('mega', `${root}/yadisk/z/decided.mov`, { bytes: decided, id: 'N-DECIDED' })

    await check(clouds, { streams: 1 })

    expect(clouds.downloads).toEqual([
      `mega:${root}/yadisk/z/decided.mov`,
      `mega:${root}/yadisk/a/open.mov`,
    ])
    expect((await rowOf(later, 'mega')).verified_at).not.toBeNull()
  })

  it('several streams at once start in the same order, and a stalled one holds no other', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const files = ['p/1.mov', 'p/2.mov', 'p/3.mov', 'p/4.mov']
    const revisions: string[] = []
    for (const [at, name] of files.entries()) {
      const bytes = randomBytes(300_000)
      revisions.push(await file(model, src, 'yandex_disk', name, bytes))
      // The first one stalls after a few chunks; the others give all their bytes.
      clouds.put('mega', `${root}/yadisk/${name}`, {
        bytes,
        id: `NODE-P${at}`,
        ...(at === 0 ? { stallAfter: 70_000 } : {}),
      })
    }

    const report = await check(clouds, { streams: 2, idleMs: 300, baseMs: 60_000 })

    // Taken in their order (by path here), two going at once.
    const taken = [...new Set(clouds.stats.filter((key) => key.includes(`${root}/yadisk/p/`)))]
    expect(taken).toEqual(files.map((name) => `mega:${root}/yadisk/${name}`))
    expect(clouds.maxOpen).toBe(2)
    expect(report).toMatchObject({ streams: 2, verified: 3, stalled: 1, stopped: 'done' })
    expect((await rowOf(revisions[0] as string, 'mega')).error).toMatch(/^timeout: /)
    for (const revision of revisions.slice(1)) {
      expect((await rowOf(revision, 'mega')).verified_at).not.toBeNull()
    }
  })

  it('as many stalls in a row as there are streams end the run', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const names = ['s/1.mov', 's/2.mov', 's/3.mov', 's/4.mov', 's/5.mov']
    for (const [at, name] of names.entries()) {
      const bytes = randomBytes(200_000)
      await file(model, src, 'yandex_disk', name, bytes)
      clouds.put('mega', `${root}/yadisk/${name}`, {
        bytes,
        id: `NODE-S${at}`,
        // All stall but the last, which is never reached.
        ...(at < 4 ? { stallAfter: 64 * 1024 } : {}),
      })
    }

    const report = await check(clouds, { streams: 2, idleMs: 150, baseMs: 60_000 })

    expect(report.stopped).toBe('stalled')
    expect(report.stalled).toBeGreaterThanOrEqual(2)
    expect(report.verified).toBe(0)
    expect(clouds.downloads).not.toContain(`mega:${root}/yadisk/s/5.mov`)
  })

  it('a stalled stream is cut, tried again in 30 minutes, and gives the slot back', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(400_000)
    const revision = await file(model, src, 'yandex_disk', 's/stall.mov', bytes)
    clouds.put('mega', `${root}/yadisk/s/stall.mov`, { bytes, id: 'NODE-S', stallAfter: 70_000 })
    const options = { idleMs: 150, baseMs: 60_000 }
    const runner = new WorkRunner({
      db,
      role: 'worker',
      handlers: {
        originals_check: originalsCheckHandler({ transport: () => clouds, ...options }),
        originals_audit: originalsAuditHandler({ transport: () => clouds }),
      },
      gate: createWorkGate(),
      pollMs: 50,
    })
    const tag = randomUUID()
    const checkWork = await enqueueWork(db, {
      modelId: null,
      kind: 'originals_check',
      workKey: `check:${tag}`,
      priority: 50,
    })
    const auditWork = await enqueueWork(db, {
      modelId: null,
      kind: 'originals_audit',
      workKey: `audit:${tag}`,
    })
    runner.start()
    try {
      await vi.waitFor(
        async () => {
          const { rows } = await db.execute<{ state: string }>(sql`
            SELECT state FROM work_operations
             WHERE id = ANY (${sql.param([checkWork.work.id, auditWork.work.id])}::uuid[])`)
          if (!rows.every((row) => row.state === 'succeeded')) throw new Error('not yet')
        },
        { timeout: 10_000, interval: 50 },
      )
    } finally {
      await runner.stop()
    }
    const { rows } = await db.execute<{ report: CheckReport }>(sql`
      SELECT report FROM work_operations WHERE id = ${checkWork.work.id}::uuid`)
    expect(rows[0]?.report).toMatchObject({ stalled: 1, verified: 0 })
    const copy = await rowOf(revision, 'mega')
    expect(copy.verified_at).toBeNull()
    expect(copy.error).toMatch(/^timeout: /)
    expect(copy.attempts).toBe(1)
    expect(copy.next_in_min).toBeGreaterThan(29)
    expect(copy.next_in_min).toBeLessThanOrEqual(30)
  })
})

describe('the nightly audit', () => {
  it('a broken listing marks nothing missing', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(10_000)
    const revision = await file(model, src, 'yandex_disk', 'p/a.jpg', bytes)
    clouds.put('yadisk', 'p/a.jpg', { bytes })
    clouds.put('mega', `${root}/yadisk/p/a.jpg`, { bytes, id: 'NODE-P' })
    await check(clouds)
    clouds.remove('mega', `${root}/yadisk/p/a.jpg`)
    clouds.broken.add('mega')

    const night = new Date('2026-12-01T00:00:00Z')
    const first = await audit(clouds, night)
    await audit(clouds, new Date(night.getTime() + 24 * 3_600_000))

    expect(first.listings).toContainEqual(
      expect.objectContaining({ place: 'mega', complete: false }),
    )
    const copy = await rowOf(revision, 'mega')
    expect(copy.verified_at).not.toBeNull()
    expect(copy.unseen_since).toBeNull()
    expect(copy.missing_since).toBeNull()
    // The origin, listed whole with the revision's MD5, is checked by the list.
    expect(await rowOf(revision, 'yandex')).toMatchObject({ verified_by: 'worker:originals' })
  })

  it('a checked copy is missing after two whole nights without it, not after one', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const gone = randomBytes(10_000)
    const swapped = randomBytes(10_000)
    const goneRevision = await file(model, src, 'yandex_disk', 'q/gone.jpg', gone)
    const swappedRevision = await file(model, src, 'yandex_disk', 'q/swapped.jpg', swapped)
    clouds.put('mega', `${root}/yadisk/q/gone.jpg`, { bytes: gone, id: 'NODE-G' })
    clouds.put('mega', `${root}/yadisk/q/swapped.jpg`, { bytes: swapped, id: 'NODE-W' })
    await check(clouds)
    const night = new Date('2026-12-05T00:00:00Z')
    await audit(clouds, night)
    expect((await rowOf(goneRevision, 'mega')).last_seen_at).toEqual(night)

    clouds.remove('mega', `${root}/yadisk/q/gone.jpg`)
    // Another node under the path, even of the same size, is not what was checked.
    clouds.put('mega', `${root}/yadisk/q/swapped.jpg`, { bytes: swapped, id: 'NODE-W2' })
    const first = new Date(night.getTime() + 24 * 3_600_000)
    await audit(clouds, first)
    for (const revision of [goneRevision, swappedRevision]) {
      expect(await rowOf(revision, 'mega')).toMatchObject({
        unseen_since: first,
        missing_since: null,
      })
    }
    // A second run the same night is still one night.
    await audit(clouds, new Date(first.getTime() + 3_600_000))
    expect((await rowOf(goneRevision, 'mega')).missing_since).toBeNull()

    const second = new Date(first.getTime() + 24 * 3_600_000)
    const report = await audit(clouds, second)
    expect(report.missing).toBe(2)
    for (const revision of [goneRevision, swappedRevision]) {
      const copy = await rowOf(revision, 'mega')
      expect(copy.missing_since).toEqual(first)
      expect(copy.verified_at).not.toBeNull()
    }
    // Back as it was checked: found again.
    clouds.put('mega', `${root}/yadisk/q/gone.jpg`, { bytes: gone, id: 'NODE-G' })
    await audit(clouds, new Date(second.getTime() + 24 * 3_600_000))
    expect(await rowOf(goneRevision, 'mega')).toMatchObject({
      unseen_since: null,
      missing_since: null,
    })
  })
})

describe('the switch and the configuration', () => {
  it('off — the works wait and nothing is read', async () => {
    const { model, src, root, clouds } = await yandexModel()
    const bytes = randomBytes(5_000)
    await file(model, src, 'yandex_disk', 'o/a.mov', bytes)
    clouds.put('mega', `${root}/yadisk/o/a.mov`, { bytes, id: 'NODE-O' })
    await setOriginalsSwitch(db, false)
    const runner = new WorkRunner({
      db,
      role: 'worker',
      handlers: { originals_check: originalsCheckHandler({ transport: () => clouds }) },
      gate: createWorkGate(),
      pollMs: 50,
    })
    try {
      const { work } = await enqueueWork(db, {
        modelId: null,
        kind: 'originals_check',
        workKey: `check:${randomUUID()}`,
      })
      await runner.tick()
      await vi.waitFor(
        async () => {
          const { rows } = await db.execute<{ paused_reason: string | null }>(sql`
            SELECT paused_reason FROM work_operations WHERE id = ${work.id}::uuid`)
          expect(rows[0]?.paused_reason).toBe('switch_off:originals.enabled')
        },
        { timeout: 5_000, interval: 50 },
      )
      expect(clouds.downloads).toHaveLength(0)
    } finally {
      await runner.stop()
      await setOriginalsSwitch(db, true)
    }
    // The model's own «off» keeps it out while the rest runs.
    await systemTx(db, (tx) =>
      tx.execute(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${model}::uuid, 'originals.enabled', 'false'::jsonb)`),
    )
    expect(await check(clouds)).toMatchObject({ due: 0, enrolled: { origins: 0, copies: 0 } })
    expect(clouds.downloads).toHaveLength(0)
  })

  it('the excluded folders are not originals: no rows, not counted (ContentOps own copies)', async () => {
    const model = await newModel()
    const src = await source(model, 'dropbox')
    await configure(model, {
      dropbox: 'dropbox-x:',
      mega: 'mega:originals/x',
      copies: { dropbox: 'dropbox' },
      exclude: { dropbox: ['Архив Я.Диска'] },
    })
    const kept = await file(model, src, 'dropbox', 'New/clip.mov', randomBytes(10))
    const archived = await file(
      model,
      src,
      'dropbox',
      'архив я.диска/1. PPV/a.mov',
      randomBytes(10),
    )
    const clouds = new FakeClouds()
    await check(clouds)
    expect((await rowOf(kept, 'mega')).path).toBe('originals/x/dropbox/New/clip.mov')
    await expect(rowOf(archived, 'mega')).rejects.toThrow(/no mega row/)
    // The copy of Я.Диск in the model's Dropbox is not a second set of originals.
    await expect(rowOf(archived, 'dropbox')).rejects.toThrow(/no dropbox row/)
    const ids = (await originalStates(db, model)).map((state) => state.id)
    expect(ids).toContain(kept)
    expect(ids).not.toContain(archived)
  })

  it('rclone is asked to read only: a write is refused before it is sent', async () => {
    const rclone = new RcloneTransport({ binary: '/nonexistent/rclone', config: '/nonexistent' })
    for (const command of ['operations/deletefile', 'operations/copyfile', 'sync/copy']) {
      await expect(rclone.call(command, {})).rejects.toMatchObject({ code: 'refused' })
    }
    expect(servePath('mega', 'originals/a [1]/#x %.mov')).toBe(
      '/%5Bmega%3A%5D/originals/a%20%5B1%5D/%23x%20%25.mov',
    )
  })

  it('a listing gives paths inside the listed folder, as rclone’s rc gives them from the root', () => {
    // `operations/list` of fs `mega:` and remote `originals/lora` answers `originals/lora/…`
    // (seen in production 24.11.2026): the audit joined the folder twice and saw no copy.
    expect(listedPath('originals/lora/yadisk/7. Pictures/a.jpg', 'originals/lora')).toBe(
      'yadisk/7. Pictures/a.jpg',
    )
    expect(listedPath('originals/lora/yadisk/a.jpg', 'originals/lora/')).toBe('yadisk/a.jpg')
    expect(listedPath('1. PPV/a.mov', '')).toBe('1. PPV/a.mov')
    expect(listedPath('originals/loraX/a.mov', 'originals/lora')).toBe('originals/loraX/a.mov')
  })
})

describe('the line of «Состояние»', () => {
  it('counts the ledger and raises ▲ for missing copies, low space and a stale list', async () => {
    const { model, src, root, clouds } = await yandexModel({ pc: ['ydisk_copy'] })
    const bytes = randomBytes(1_000)
    await file(model, src, 'yandex_disk', 'l/a.mov', bytes)
    clouds.put('mega', `${root}/yadisk/l/a.mov`, { bytes, id: 'NODE-L' })
    clouds.space.set('mega', { total: 1000, used: 950, free: 50 })
    await check(clouds)
    const runner = new WorkRunner({
      db,
      role: 'worker',
      handlers: {
        originals_audit: originalsAuditHandler({ transport: () => clouds }),
      },
      pollMs: 50,
    })
    const { work } = await enqueueWork(db, {
      modelId: null,
      kind: 'originals_audit',
      workKey: `audit:${randomUUID()}`,
    })
    runner.start()
    try {
      await vi.waitFor(
        async () => {
          const { rows } = await db.execute<{ state: string }>(sql`
            SELECT state FROM work_operations WHERE id = ${work.id}::uuid`)
          expect(rows[0]?.state).toBe('succeeded')
        },
        { timeout: 10_000, interval: 50 },
      )
    } finally {
      await runner.stop()
    }
    const host = await mkdtemp(join(tmpdir(), 'co-host-'))
    await writeFile(
      join(host, 'ydisk-copy-list.meta.json'),
      JSON.stringify({ finished_at: '2026-01-01T00:00:00Z' }),
    )
    const line = await originalsLine(db, { hostDir: host })
    expect(line).not.toBeNull()
    expect(line?.reliable).toBeGreaterThanOrEqual(0)
    expect(line?.originals).toBeGreaterThan(0)
    expect(line?.audited_at).not.toBeNull()
    expect(line?.warnings).toContainEqual(expect.stringMatching(/^мало места: MEGA/))
    // Nothing of this model may go yet (no master): a stale list is no ▲.
    expect(line?.warnings.some((w) => w.startsWith('список копии Я.Диска'))).toBe(false)
  })
})
