import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Db, WorkContext, WorkRow } from '@contentops/db'
import { dropboxContentHash } from '@contentops/sources'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BlobStore, blobKey } from '../media/storage'
import { systemTx, tempStore } from '../media/testing'
import { type TestServer, testServer } from '../testing/server'
import { type CheckReport, originalsCheckHandler } from './check'
import { MODEL_CONFIG_KEY } from './config'
import { type CopyReport, originalsCopyHandler } from './copy'
import { RcloneTransport } from './rclone'
import { FakeClouds } from './testing'
import { assertWrite, TransportError } from './transport'
import { setOriginalsSwitch } from './work'

/**
 * The copy of the originals by ContentOps (SPEC §9.4, migration 0029): it writes only where it
 * may — MEGA under `originals/`, a Dropbox only in the folders of ContentOps the model keeps apart
 * — never deletes in Dropbox, never overwrites; wrong bytes never land and leave no part; a copy
 * is checked only by the very bytes it streamed when they match the original.
 */

let server: TestServer
let db: Db
let store: BlobStore
let owner: string

beforeAll(async () => {
  server = await testServer()
  db = server.db
  store = await tempStore('copy')
  await setOriginalsSwitch(db, true)
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM principals WHERE login = 'dmitriy'`)
  owner = rows[0]?.id as string
})
afterAll(() => server.close())

const DAY = '2026-12-01'
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex')
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function newModel(): Promise<string> {
  return systemTx(db, async (tx) => {
    const code = `c${randomUUID().slice(0, 8)}`
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

/** A live file of the source with one revision and the hashes its cloud gave for `bytes`. */
async function file(
  model: string,
  src: string,
  kind: 'yandex_disk' | 'dropbox',
  path: string,
  bytes: Uint8Array,
  options: { staged?: boolean } = {},
): Promise<string> {
  const full = kind === 'yandex_disk' ? `disk:/${path}` : `/${path}`
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
              ${kind === 'yandex_disk' ? Buffer.from(md5(bytes), 'hex') : null},
              ${kind === 'yandex_disk' ? Buffer.from(sha256(bytes), 'hex') : null},
              ${kind === 'dropbox' ? Buffer.from(dropboxContentHash(bytes), 'hex') : null},
              ${kind === 'dropbox' ? randomUUID().replaceAll('-', '') : null},
              ${options.staged ? Buffer.from(sha256(bytes), 'hex') : null},
              ${options.staged ? new Date() : null}, ${options.staged ? 'download' : null})
      RETURNING id`)
    const revision = revisions[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${revision}::uuid WHERE id = ${object}::uuid`)
    if (options.staged) {
      await mkdir(store.stagingDir, { recursive: true })
      await writeFile(join(store.stagingDir, `${sha256(bytes)}.mov`), bytes)
    }
    return revision
  })
}

/** A registered web upload whose blob lies on our disk. */
async function upload(model: string, name: string, bytes: Uint8Array): Promise<string> {
  const sha = sha256(bytes)
  const key = blobKey(sha, 'mov')
  await mkdir(dirname(store.path(key)), { recursive: true })
  await writeFile(store.path(key), bytes)
  return systemTx(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key, state)
      VALUES (${Buffer.from(sha, 'hex')}, ${bytes.length}, 'video/quicktime', 'mov', 'video',
              ${key}, 'present')
      ON CONFLICT DO NOTHING`)
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO web_uploads (model_id, upload_id, principal_id, client_filename, declared_kind,
                               size_expected, bytes_received, sha256, state, tmp_key, created_at)
      VALUES (${model}::uuid, ${randomUUID()}, ${owner}::uuid, ${name}, 'other', ${bytes.length},
              ${bytes.length}, ${Buffer.from(sha, 'hex')}, 'registered',
              ${`inbox/web/${randomUUID()}`}, '2026-11-20T12:00:00Z')
      RETURNING id`)
    return rows[0]?.id as string
  })
}

/** The model is the only one the works look at. */
async function configure(model: string, config: Record<string, unknown>, notContent?: string[]) {
  await systemTx(db, async (tx) => {
    await tx.execute(sql`
      UPDATE policy_settings SET value = NULL WHERE key = ${MODEL_CONFIG_KEY} AND value IS NOT NULL`)
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value)
      VALUES (${model}::uuid, ${MODEL_CONFIG_KEY}, ${JSON.stringify(config)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
    if (notContent) {
      await tx.execute(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${model}::uuid, 'legacy.not_content.dropbox',
                ${JSON.stringify({ paths: notContent })}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE SET value = excluded.value`)
    }
  })
}

interface CopyRow {
  id: string
  path: string
  object_ref: string | null
  verified_by: string | null
  seen_md5: string | null
  seen_sha256: string | null
  seen_dropbox: string | null
  error: string | null
}

async function rowOf(
  original: { revision?: string; upload?: string },
  place: 'dropbox' | 'mega',
): Promise<CopyRow> {
  const { rows } = await db.execute<CopyRow & Record<string, unknown>>(sql`
    SELECT id, path, object_ref, verified_by, encode(seen_md5, 'hex') AS seen_md5,
           encode(seen_sha256, 'hex') AS seen_sha256,
           encode(seen_dropbox_hash, 'hex') AS seen_dropbox, error
      FROM original_copies
     WHERE place = ${place} AND role = 'copy'
       AND (source_revision_id = ${original.revision ?? null}::uuid
            OR web_upload_id = ${original.upload ?? null}::uuid)`)
  const row = rows[0]
  if (!row) throw new Error(`no ${place} copy row`)
  return row
}

function context(): WorkContext {
  return {
    work: {} as WorkRow,
    signal: new AbortController().signal,
    db,
    checkpoint: async () => {},
  }
}

async function copy(clouds: FakeClouds): Promise<CopyReport> {
  const handler = originalsCopyHandler({
    transport: () => clouds,
    store,
    streams: 2,
    now: () => new Date(`${DAY}T12:00:00Z`),
  })
  return (await handler(context()))?.report as CopyReport
}

async function check(clouds: FakeClouds): Promise<CheckReport> {
  const handler = originalsCheckHandler({ transport: () => clouds, streams: 2 })
  return (await handler(context()))?.report as CheckReport
}

/** A model with a Dropbox whose new files the copy puts into MEGA under `<root>/dropbox`. */
async function dropboxModel(extra: Record<string, unknown> = {}, notContent?: string[]) {
  const model = await newModel()
  const src = await source(model, 'dropbox')
  const root = `originals/${randomUUID().slice(0, 8)}`
  const remote = `dropbox-${randomUUID().slice(0, 6)}`
  await configure(
    model,
    { dropbox: `${remote}:`, mega: `mega:${root}`, copies: { dropbox: 'dropbox' }, ...extra },
    notContent,
  )
  const clouds = new FakeClouds()
  clouds.hashes.set(remote, 'dropbox')
  return { model, src, root, remote, clouds }
}

describe('the copy of an original', () => {
  it('writes a MEGA copy cloud to cloud and checks it by the very bytes it streamed', async () => {
    const { model, src, root, remote, clouds } = await dropboxModel()
    const bytes = randomBytes(300_000)
    const revision = await file(model, src, 'dropbox', 'New/clip.mov', bytes)
    clouds.put(remote, 'New/clip.mov', { bytes, id: 'id:SRC' })

    const report = await copy(clouds)

    expect(report).toMatchObject({ copied: 1, sources: { cloud: 1 }, source_mismatch: 0 })
    const target = `${root}/dropbox/New/clip.mov`
    expect(clouds.writes).toEqual([
      `upload mega:${target}.co-part`,
      `move mega:${target}.co-part -> ${target}`,
    ])
    expect(clouds.objects.get('mega')?.get(target)?.bytes).toEqual(bytes)
    expect(await rowOf({ revision }, 'mega')).toMatchObject({
      path: target,
      object_ref: clouds.objects.get('mega')?.get(target)?.id,
      verified_by: 'worker:originals',
      seen_md5: md5(bytes),
      seen_sha256: sha256(bytes),
      seen_dropbox: dropboxContentHash(bytes),
      error: null,
    })
    // Checked: the check has nothing to download.
    expect(await check(clouds)).toMatchObject({ due: 0 })
  })

  it('takes the staged bytes on our disk first, and a file already there is not written again', async () => {
    const { model, src, root, remote, clouds } = await dropboxModel()
    const staged = randomBytes(100_000)
    const there = randomBytes(80_000)
    const fromDisk = await file(model, src, 'dropbox', 'A/staged.mov', staged, { staged: true })
    const already = await file(model, src, 'dropbox', 'A/there.mov', there)
    clouds.put(remote, 'A/staged.mov', { bytes: staged, id: 'id:A' })
    clouds.put('mega', `${root}/dropbox/A/there.mov`, { bytes: there, id: 'NODE-THERE' })

    const report = await copy(clouds)

    expect(report).toMatchObject({ copied: 1, taken: 1, sources: { staging: 1, cloud: 0 } })
    expect(clouds.downloads).toEqual([])
    expect((await rowOf({ revision: fromDisk }, 'mega')).verified_by).toBe('worker:originals')
    // Found there: its node is taken, and the check reads its bytes.
    expect(await rowOf({ revision: already }, 'mega')).toMatchObject({
      object_ref: 'NODE-THERE',
      verified_by: null,
    })
    expect(clouds.writes.some((write) => write.includes('there.mov'))).toBe(false)
    expect(await check(clouds)).toMatchObject({ verified: 1 })
  })

  it('wrong bytes never land: nothing at the path, no part, the row not checked', async () => {
    const { model, src, root, remote, clouds } = await dropboxModel()
    const bytes = randomBytes(200_000)
    const revision = await file(model, src, 'dropbox', 'B/wrong.mov', bytes)
    // The source now gives other bytes than the revision's hash.
    clouds.put(remote, 'B/wrong.mov', { bytes: randomBytes(200_000), id: 'id:B' })

    const report = await copy(clouds)

    expect(report).toMatchObject({ copied: 0, source_mismatch: 1 })
    expect(clouds.writes).toEqual([])
    const target = `${root}/dropbox/B/wrong.mov`
    expect(clouds.objects.get('mega')?.has(target) ?? false).toBe(false)
    expect(clouds.objects.get('mega')?.has(`${target}.co-part`) ?? false).toBe(false)
    const row = await rowOf({ revision }, 'mega')
    expect(row.verified_by).toBeNull()
    expect(row.error).toMatch(/^mismatch: copy: /)
  })

  it('bytes the cloud stored wrong: the MEGA part is removed, the Dropbox part moved aside', async () => {
    const model = await newModel()
    const yandex = await source(model, 'yandex_disk')
    const root = `originals/${randomUUID().slice(0, 8)}`
    const remote = `dropbox-${randomUUID().slice(0, 6)}`
    await configure(
      model,
      {
        yandex_disk: 'yadisk-c:',
        dropbox: `${remote}:`,
        mega: `mega:${root}`,
        copies: { yandex_disk: 'yadisk' },
        dropbox_copies: { yandex_disk: 'Архив Я.Диска' },
        exclude: { dropbox: ['Архив Я.Диска'] },
      },
      ['Архив Я.Диска'],
    )
    const clouds = new FakeClouds()
    clouds.hashes.set(remote, 'dropbox')
    const bytes = randomBytes(150_000)
    const revision = await file(model, yandex, 'yandex_disk', 'C/broken.mov', bytes)
    clouds.put('yadisk-c', 'C/broken.mov', { bytes })
    const mega = `${root}/yadisk/C/broken.mov`
    const box = 'Архив Я.Диска/C/broken.mov'
    clouds.corrupt.add(`mega:${mega}.co-part`)
    clouds.corrupt.add(`${remote}:${box}.co-part`)

    const report = await copy(clouds)

    expect(report).toMatchObject({ copied: 0, stored_wrong: 2 })
    expect(clouds.objects.get('mega')?.has(mega) ?? false).toBe(false)
    expect(clouds.objects.get('mega')?.has(`${mega}.co-part`) ?? false).toBe(false)
    expect(clouds.writes).toContain(`remove mega:${mega}.co-part`)
    // In Dropbox nothing is deleted: the part goes to «Копии/неверные».
    expect(clouds.writes.some((write) => write.startsWith(`remove ${remote}:`))).toBe(false)
    expect(clouds.objects.get(remote)?.has(box) ?? false).toBe(false)
    expect(
      clouds.objects.get(remote)?.has(`Архив Я.Диска/Копии/неверные ${DAY}/C/broken.mov.co-part`),
    ).toBe(true)
    expect((await rowOf({ revision }, 'dropbox')).verified_by).toBeNull()
  })

  it('another file at the path is moved to «Копии/заменённые», never overwritten', async () => {
    const { model, src, root, remote, clouds } = await dropboxModel()
    const older = randomBytes(50_000)
    const newer = randomBytes(60_000)
    const target = `${root}/dropbox/D/clip.mov`
    // The older revision's copy, checked, lies at the path; the source now has a new one.
    const oldRevision = await file(model, src, 'dropbox', 'D/old-name.mov', older)
    await db.execute(sql`
      INSERT INTO original_copies (model_id, source_revision_id, place, role, remote, path,
                                   object_ref, byte_size, seen_md5, verified_at, verified_by)
      VALUES (${model}::uuid, ${oldRevision}::uuid, 'mega', 'copy', 'mega', ${target}, 'NODE-OLD',
              ${older.length}, ${Buffer.from(md5(older), 'hex')}, now(), 'night-01.12')`)
    clouds.put('mega', target, { bytes: older, id: 'NODE-OLD' })
    const revision = await file(model, src, 'dropbox', 'D/clip.mov', newer)
    clouds.put(remote, 'D/clip.mov', { bytes: newer, id: 'id:D' })

    const report = await copy(clouds)

    expect(report).toMatchObject({ copied: 1, moved_aside: 1 })
    const aside = `${root}/Копии/заменённые ${DAY}/dropbox/D/clip.mov`
    expect(clouds.objects.get('mega')?.get(aside)?.bytes).toEqual(older)
    expect(clouds.objects.get('mega')?.get(target)?.bytes).toEqual(newer)
    expect(clouds.writes[0]).toBe(`move mega:${target} -> ${aside}`)
    // The row of the old copy follows its node, still checked.
    const { rows } = await db.execute<{ path: string; verified: boolean }>(sql`
      SELECT path, verified_at IS NOT NULL AS verified FROM original_copies
       WHERE source_revision_id = ${oldRevision}::uuid AND place = 'mega'`)
    expect(rows[0]).toEqual({ path: aside, verified: true })
    expect((await rowOf({ revision }, 'mega')).verified_by).toBe('worker:originals')
  })
})

describe('a copy the check found wrong', () => {
  it('is moved aside and written again once, then checked by its stream', async () => {
    const { model, src, root, remote, clouds } = await dropboxModel()
    const bytes = randomBytes(70_000)
    const revision = await file(model, src, 'dropbox', 'E/same-size.mov', bytes)
    clouds.put(remote, 'E/same-size.mov', { bytes, id: 'id:E' })
    const target = `${root}/dropbox/E/same-size.mov`
    // The night's copy left other bytes of the same size under the path.
    clouds.put('mega', target, { bytes: randomBytes(70_000), id: 'NODE-BAD' })

    expect(await copy(clouds)).toMatchObject({ taken: 1, copied: 0 })
    expect(await check(clouds)).toMatchObject({ mismatched: 1 })
    expect((await rowOf({ revision }, 'mega')).error).toMatch(/^mismatch: /)

    expect(await copy(clouds)).toMatchObject({ moved_aside: 1, copied: 1 })
    expect(clouds.objects.get('mega')?.get(target)?.bytes).toEqual(bytes)
    expect(
      clouds.objects.get('mega')?.get(`${root}/Копии/заменённые ${DAY}/dropbox/E/same-size.mov`)
        ?.id,
    ).toBe('NODE-BAD')
    expect(await rowOf({ revision }, 'mega')).toMatchObject({
      verified_by: 'worker:originals',
      seen_sha256: sha256(bytes),
      error: null,
    })
  })
})

describe('where ContentOps may write', () => {
  it('a write outside the folders is refused before rclone is asked anything', async () => {
    // No binary, no configuration: a write that got past the path would fail, not be refused.
    const rclone = new RcloneTransport({ binary: '/nonexistent/rclone', config: '/nonexistent' })
    const source = {
      size: 1,
      open: async () =>
        (async function* () {
          yield new Uint8Array(1)
        })(),
    }
    const signal = new AbortController().signal
    for (const path of [
      'Photos/a.mov.co-part',
      'originals',
      '../originals/a.co-part',
      '/originals/a.co-part',
    ]) {
      await expect(rclone.upload('dropbox-x', path, source, signal)).rejects.toMatchObject({
        code: 'refused',
      })
    }
    await expect(rclone.upload('mega', 'originals/a/x.mov', source, signal)).rejects.toMatchObject({
      code: 'refused',
    })
    await expect(rclone.move('mega', 'originals/a/x', 'other/x')).rejects.toMatchObject({
      code: 'refused',
    })
    await expect(rclone.removePart('dropbox-x', 'Photos/x.co-part')).rejects.toMatchObject({
      code: 'refused',
    })
    // No delete but of our part, and no other writing command at all.
    for (const command of [
      'operations/deletefile',
      'operations/purge',
      'operations/delete',
      'sync/copy',
    ]) {
      await expect(rclone.call(command, {})).rejects.toMatchObject({ code: 'refused' })
    }
  })

  it('each cloud by its rclone type: MEGA under originals/, Dropbox in its two folders, Я.Диск never', () => {
    const refused = (kind: string | null, op: 'upload' | 'move' | 'remove', path: string) => {
      try {
        assertWrite(kind, op, path)
        return false
      } catch (error) {
        return error instanceof TransportError && error.code === 'refused'
      }
    }
    expect(refused('mega', 'upload', 'originals/lora/a.mov.co-part')).toBe(false)
    expect(refused('mega', 'upload', 'Архив Я.Диска/a.mov.co-part')).toBe(true)
    expect(refused('dropbox', 'upload', 'Архив Я.Диска/1. PPV/a.mov.co-part')).toBe(false)
    expect(refused('dropbox', 'move', 'загрузки contentops/2026-11/a.mov')).toBe(false)
    expect(refused('dropbox', 'upload', 'originals/lora/a.mov.co-part')).toBe(true)
    expect(refused('dropbox', 'upload', '1. PPV/a.mov.co-part')).toBe(true)
    expect(refused('yandex', 'upload', 'originals/a.mov.co-part')).toBe(true)
    expect(refused(null, 'upload', 'originals/a.mov.co-part')).toBe(true)
    // Nothing is ever deleted in Dropbox, not even a part; MEGA — only a part.
    expect(refused('dropbox', 'remove', 'Архив Я.Диска/a.mov.co-part')).toBe(true)
    expect(refused('mega', 'remove', 'originals/lora/a.mov')).toBe(true)
    expect(refused('mega', 'remove', 'originals/lora/a.mov.co-part')).toBe(false)
  })

  it('a web upload goes to MEGA, and to Dropbox only once the model keeps the folder apart', async () => {
    const { model, root, remote, clouds } = await dropboxModel({}, [])
    const bytes = randomBytes(120_000)
    const id = await upload(model, 'Новый ролик: финал?.mov', bytes)

    const first = await copy(clouds)

    expect(first.refused).toEqual([
      {
        model: expect.any(String),
        place: 'dropbox',
        folder: 'Загрузки ContentOps',
        why: 'not in exclude.dropbox of originals.model_config',
      },
    ])
    expect(first).toMatchObject({ copied: 1, held: 1, sources: { blob: 1 } })
    const mega = `${root}/Загрузки ContentOps/2026-11/${id}_Новый ролик_ финал_.mov`
    expect(await rowOf({ upload: id }, 'mega')).toMatchObject({
      path: mega,
      verified_by: 'worker:originals',
      seen_sha256: sha256(bytes),
    })
    expect(clouds.writes.some((write) => write.includes(`${remote}:`))).toBe(false)

    // In exclude but not yet in legacy.not_content.dropbox: still nothing written there.
    await configure(model, {
      dropbox: `${remote}:`,
      mega: `mega:${root}`,
      exclude: { dropbox: ['Загрузки ContentOps'] },
    })
    expect((await copy(clouds)).refused[0]?.why).toBe('not in legacy.not_content.dropbox')

    await configure(
      model,
      {
        dropbox: `${remote}:`,
        mega: `mega:${root}`,
        exclude: { dropbox: ['Загрузки ContentOps'] },
      },
      ['Загрузки ContentOps'],
    )
    const third = await copy(clouds)
    expect(third).toMatchObject({ copied: 1, refused: [] })
    const box = await rowOf({ upload: id }, 'dropbox')
    expect(box).toMatchObject({
      path: `Загрузки ContentOps/2026-11/${id}_Новый ролик_ финал_.mov`,
      verified_by: 'worker:originals',
      seen_dropbox: dropboxContentHash(bytes),
    })
  })
})

describe('the copy of Я.Диск in the model’s Dropbox', () => {
  it('a file already there is checked by its Dropbox hash, never uploaded again', async () => {
    const model = await newModel()
    const yandex = await source(model, 'yandex_disk')
    const root = `originals/${randomUUID().slice(0, 8)}`
    const remote = `dropbox-${randomUUID().slice(0, 6)}`
    await configure(
      model,
      {
        yandex_disk: 'yadisk-e:',
        dropbox: `${remote}:`,
        mega: `mega:${root}`,
        copies: { yandex_disk: 'yadisk' },
        dropbox_copies: { yandex_disk: 'Архив Я.Диска' },
        exclude: { dropbox: ['Архив Я.Диска'] },
      },
      ['Архив Я.Диска'],
    )
    const clouds = new FakeClouds()
    clouds.hashes.set(remote, 'dropbox')
    const bytes = randomBytes(90_000)
    const revision = await file(model, yandex, 'yandex_disk', '1. PPV/a.mov', bytes)
    clouds.put('yadisk-e', '1. PPV/a.mov', { bytes })
    clouds.put('mega', `${root}/yadisk/1. PPV/a.mov`, { bytes, id: 'NODE-E' })
    clouds.put(remote, 'Архив Я.Диска/1. PPV/a.mov', { bytes, id: 'id:ARCHIVE' })

    // Both copies are there: taken, not written.
    expect(await copy(clouds)).toMatchObject({ copied: 0, taken: 2 })
    expect(clouds.writes).toEqual([])

    // The MEGA copy's bytes give the original's Dropbox hash; the Dropbox copy waits for it…
    expect(await check(clouds)).toMatchObject({ verified: 1, deferred: 1 })
    // …and is then checked by its listing, without a download.
    expect(await check(clouds)).toMatchObject({ verified: 1, reused: 1, downloaded_bytes: 0 })
    expect(clouds.downloads).toEqual([`mega:${root}/yadisk/1. PPV/a.mov`])
    expect(await rowOf({ revision }, 'dropbox')).toMatchObject({
      object_ref: 'id:ARCHIVE',
      verified_by: 'worker:originals',
      seen_dropbox: dropboxContentHash(bytes),
    })
  })
})
