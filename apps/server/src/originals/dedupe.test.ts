import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemTx } from '../media/testing'
import { type TestServer, testServer } from '../testing/server'
import { configuredModels, MODEL_CONFIG_KEY } from './config'
import { ledgerKeeps, megaDedupe } from './dedupe'
import { enrolOriginals } from './enrol'
import { RcloneTransport } from './rclone'
import { FakeClouds } from './testing'
import { assertWrite, type DuplicateTarget, TransportError } from './transport'

/**
 * `ops.js originals mega-dedupe` (SPEC §9.4): a duplicate of Я.Диск in MEGA under the name
 * Windows gave it goes only when the bytes of both nodes are the revision's; the canonical copy,
 * an ambiguous or unexplained file is never touched; a node changed between the check and the
 * delete stays; the dry run downloads and writes nothing; the fence refuses any other delete.
 */

let server: TestServer
let db: Db

beforeAll(async () => {
  server = await testServer()
  db = server.db
})
afterAll(() => server.close())

const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest()
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
const node = (name: string) => `${name}-${randomUUID().slice(0, 8)}`

interface Model {
  id: string
  code: string
  src: string
  root: string
  clouds: FakeClouds
}

/** A model whose Я.Диск lies in MEGA under `<root>/yadisk`, the only one configured. */
async function model(): Promise<Model> {
  const code = `m${randomUUID().slice(0, 8)}`
  const root = `originals/${code}`
  const { id, src } = await systemTx(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO models (code, title, title_genitive) VALUES (${code}, ${code}, ${code})
      RETURNING id`)
    const id = rows[0]?.id as string
    const { rows: sources } = await tx.execute<{ id: string }>(sql`
      INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
      VALUES (${id}::uuid, 'yandex_disk', ${`ydisk ${code}`}, 'disk:/', 'TOKEN')
      RETURNING id`)
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value)
      VALUES (${id}::uuid, ${MODEL_CONFIG_KEY},
              ${JSON.stringify({ yandex_disk: 'yadisk:', mega: `mega:${root}`, copies: { yandex_disk: 'yadisk' } })}::jsonb)`)
    return { id, src: sources[0]?.id as string }
  })
  return { id, code, src, root, clouds: new FakeClouds() }
}

/** A file of the model's Я.Диск with its one revision (MD5 and SHA-256 of `bytes`). */
async function file(m: Model, path: string, bytes: Uint8Array): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      VALUES (${m.id}::uuid, ${m.src}::uuid, ${`id:${randomUUID()}`}, ${`disk:/${path}`},
              ${path.slice(path.lastIndexOf('/') + 1)})
      RETURNING id`)
    const object = objects[0]?.id as string
    const { rows: revisions } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size, md5,
                                    remote_sha256)
      VALUES (${m.id}::uuid, ${object}::uuid, 1, ${bytes.length}, ${md5(bytes)},
              ${sha256(bytes)})
      RETURNING id`)
    const revision = revisions[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${revision}::uuid WHERE id = ${object}::uuid`)
    return revision
  })
}

/** The ledger's rows, as the copy work's enrolment makes them (no node yet). */
async function enrol(m: Model): Promise<void> {
  const { models } = await configuredModels(db, { all: true })
  const configured = models.find((one) => one.id === m.id)
  if (!configured) throw new Error('not configured')
  await enrolOriginals(db, configured)
}

/** The MEGA copy of `revision` checked in the ledger with `id` (as `seed` or the check left it). */
async function checked(revision: string, id: string, bytes: Uint8Array): Promise<void> {
  await db.execute(sql`
    UPDATE original_copies
       SET object_ref = ${id}, byte_size = ${bytes.length}, seen_md5 = ${md5(bytes)},
           verified_at = now(), verified_by = 'night-24.11'
     WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
}

async function megaRow(revision: string) {
  const { rows } = await db.execute<{
    object_ref: string | null
    verified_by: string | null
    seen_md5: string | null
  }>(sql`
    SELECT object_ref, verified_by, encode(seen_md5, 'hex') AS seen_md5
      FROM original_copies WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
  return rows[0]
}

async function journal(m: Model): Promise<Record<string, unknown>[]> {
  const { rows } = await db.execute<{ after: Record<string, unknown> }>(sql`
    SELECT after FROM action_log
     WHERE model_id = ${m.id}::uuid AND action = 'originals.mega_dedupe' ORDER BY id`)
  return rows.map((row) => row.after)
}

const run = (m: Model, write: boolean, extra: Partial<Parameters<typeof megaDedupe>[1]> = {}) =>
  megaDedupe(db, { model: m.code, transport: m.clouds, write, streams: 2, ...extra })

const mega = (m: Model, path: string) => `${m.root}/yadisk/${path}`

/**
 * A: `13:03 tail.mov`, canonical checked in the ledger, its duplicate `13-03 tail.mov`;
 * B: `Какао /b.mov` (a folder with a space at the end), canonical not checked yet, its
 * duplicate `Какао-/b.mov`; C — canonical only; and the files that are no pair: two Я.Диск
 * paths for one Windows name, a stray file, another size, a duplicate without its canonical copy.
 */
async function folder(m: Model) {
  const a = randomBytes(200_000)
  const b = randomBytes(150_000)
  const c = randomBytes(1_000)
  const s = randomBytes(5_000)
  const f = randomBytes(2_000)
  const n = randomBytes(3_000)
  const revA = await file(m, '3. Customs/13:03 tail.mov', a)
  const revB = await file(m, 'Какао /b.mov', b)
  await file(m, 'c.mov', c)
  await file(m, 'F:/f.mov', f)
  await file(m, 'F /f.mov', f)
  await file(m, 's:1.mov', s)
  await file(m, 'n:1.mov', n)
  await enrol(m)
  const ids = {
    a: node('A'),
    a2: node('A2'),
    b: node('B'),
    b2: node('B2'),
    c: node('C'),
  }
  await checked(revA, ids.a, a)
  const put = (path: string, bytes: Uint8Array, id = node('X')) =>
    m.clouds.put('mega', mega(m, path), { bytes, id })
  put('3. Customs/13:03 tail.mov', a, ids.a)
  put('3. Customs/13-03 tail.mov', a, ids.a2)
  put('Какао /b.mov', b, ids.b)
  put('Какао-/b.mov', b, ids.b2)
  put('c.mov', c, ids.c)
  put('F-/f.mov', f)
  put('stray.mov', randomBytes(100))
  put('s:1.mov', s)
  put('s-1.mov', s.subarray(0, s.length - 1))
  put('n-1.mov', n)
  return { a, b, revA, revB, ids }
}

describe('mega-dedupe: the pairs', () => {
  it('the dry run counts the pairs and the rest by reason, and downloads and writes nothing', async () => {
    const m = await model()
    await folder(m)
    const before = await db.execute(sql`
      SELECT count(*)::int AS n FROM original_copies WHERE model_id = ${m.id}::uuid
         AND verified_at IS NOT NULL`)

    const report = await run(m, false, { list: true })

    expect(report).toMatchObject({
      written: false,
      folder: `mega:${m.root}/yadisk`,
      listed: { files: 10 },
      canonical: { files: 4 },
      pairs: {
        files: 2,
        bytes: 350_000,
        canonical_checked: 1,
        canonical_to_check: { files: 1, bytes: 150_000 },
        download: { files: 3, bytes: 500_000 },
      },
      skipped: {
        ambiguous: { files: 1 },
        unexplained: { files: 1 },
        size_differs: { files: 1 },
        no_canonical: { files: 1 },
      },
    })
    expect(report.deleted).toBeUndefined()
    expect(report.list?.pairs.map((pair) => pair.duplicate).sort()).toEqual([
      '3. Customs/13-03 tail.mov',
      'Какао-/b.mov',
    ])
    expect(m.clouds.flushes).toBe(1)
    expect(m.clouds.downloads).toEqual([])
    expect(m.clouds.writes).toEqual([])
    const after = await db.execute(sql`
      SELECT count(*)::int AS n FROM original_copies WHERE model_id = ${m.id}::uuid
         AND verified_at IS NOT NULL`)
    expect(after.rows).toEqual(before.rows)
    expect(await journal(m)).toEqual([])
  })

  it('--yes deletes each duplicate once both nodes are the revision’s, and nothing else', async () => {
    const m = await model()
    const { revB, ids, b } = await folder(m)

    const report = await run(m, true)

    expect(report).toMatchObject({
      deleted: { files: 2, bytes: 350_000 },
      gone: 0,
      not_deleted: {},
      canonical_verified: 1,
      stopped: 'done',
    })
    expect(report.list).toBeUndefined()
    expect(m.clouds.writes.sort()).toEqual([
      `remove-duplicate mega:${mega(m, '3. Customs/13-03 tail.mov')}`,
      `remove-duplicate mega:${mega(m, 'Какао-/b.mov')}`,
    ])
    // The checked canonical copy is not downloaded again; the unchecked one is, and kept checked.
    expect(m.clouds.downloads.sort()).toEqual(
      [
        `mega:${mega(m, '3. Customs/13-03 tail.mov')}`,
        `mega:${mega(m, 'Какао /b.mov')}`,
        `mega:${mega(m, 'Какао-/b.mov')}`,
      ].sort(),
    )
    expect(await megaRow(revB)).toEqual({
      object_ref: ids.b,
      verified_by: 'ops:mega-dedupe',
      seen_md5: md5(b).toString('hex'),
    })
    const left = [...(m.clouds.objects.get('mega')?.keys() ?? [])]
      .map((path) => path.slice(`${m.root}/yadisk/`.length))
      .sort()
    expect(left).toEqual(
      [
        '3. Customs/13:03 tail.mov',
        'Какао /b.mov',
        'c.mov',
        'F-/f.mov',
        'stray.mov',
        's:1.mov',
        's-1.mov',
        'n-1.mov',
      ].sort(),
    )
    const [entry] = await journal(m)
    expect(entry).toMatchObject({ deleted: { files: 2 }, stopped: 'done' })
    const removed = (entry?.removed ?? []) as { node: string }[]
    expect(removed.map((r) => r.node).sort()).toEqual([ids.a2, ids.b2].sort())

    // A repeat finds nothing left to pair and downloads nothing.
    m.clouds.downloads.length = 0
    const again = await run(m, true)
    expect(again).toMatchObject({ pairs: { files: 0 }, deleted: { files: 0 } })
    expect(m.clouds.downloads).toEqual([])
  })
})

describe('mega-dedupe: nothing goes on a doubt', () => {
  it('a duplicate whose bytes are not the revision’s stays', async () => {
    const m = await model()
    const a = randomBytes(50_000)
    const rev = await file(m, 'x:1.mov', a)
    await enrol(m)
    const id = node('A')
    await checked(rev, id, a)
    const wrong = Buffer.from(a)
    wrong[100] = (wrong[100] ?? 0) ^ 0xff
    m.clouds.put('mega', mega(m, 'x:1.mov'), { bytes: a, id })
    m.clouds.put('mega', mega(m, 'x-1.mov'), { bytes: wrong, id: node('A2') })

    const report = await run(m, true)

    expect(report).toMatchObject({
      deleted: { files: 0 },
      not_deleted: { duplicate_mismatch: 1 },
    })
    expect(m.clouds.writes).toEqual([])
    expect(m.clouds.objects.get('mega')?.has(mega(m, 'x-1.mov'))).toBe(true)
  })

  it('a canonical copy not checked and with wrong bytes keeps its duplicate, which is not even read', async () => {
    const m = await model()
    const a = randomBytes(50_000)
    const rev = await file(m, 'y:1.mov', a)
    await enrol(m)
    const wrong = Buffer.from(a)
    wrong[0] = (wrong[0] ?? 0) ^ 0xff
    m.clouds.put('mega', mega(m, 'y:1.mov'), { bytes: wrong, id: node('A') })
    m.clouds.put('mega', mega(m, 'y-1.mov'), { bytes: a, id: node('A2') })

    const report = await run(m, true)

    expect(report).toMatchObject({
      deleted: { files: 0 },
      not_deleted: { canonical_mismatch: 1 },
      canonical_verified: 0,
    })
    expect(m.clouds.downloads).toEqual([`mega:${mega(m, 'y:1.mov')}`])
    expect(m.clouds.writes).toEqual([])
    expect((await megaRow(rev))?.verified_by).toBeNull()
  })

  it('a node changed between the check and the delete stays', async () => {
    const m = await model()
    const a = randomBytes(50_000)
    const rev = await file(m, 'z:1.mov', a)
    await enrol(m)
    const id = node('A')
    await checked(rev, id, a)
    m.clouds.put('mega', mega(m, 'z:1.mov'), { bytes: a, id })
    m.clouds.put('mega', mega(m, 'z-1.mov'), { bytes: a, id: node('A2') })
    // Another node lands under the duplicate's path right after its stream…
    m.clouds.onStreamEnd = (remote, path) => {
      if (path.endsWith('z-1.mov')) m.clouds.put(remote, path, { bytes: a, id: node('NEW') })
    }

    const first = await run(m, true)
    expect(first).toMatchObject({ deleted: { files: 0 }, not_deleted: { node_changed: 1 } })

    // …or right before the delete: the fence takes only the node that was checked.
    m.clouds.onStreamEnd = null
    m.clouds.beforeRemoveDuplicate = (remote, path) =>
      m.clouds.put(remote, path, { bytes: a, id: node('NEWER') })
    const second = await run(m, true)
    expect(second).toMatchObject({ deleted: { files: 0 }, not_deleted: { refused: 1 } })
    expect(m.clouds.writes).toEqual([])
    expect(m.clouds.objects.get('mega')?.get(mega(m, 'z-1.mov'))?.id).toMatch(/^NEWER-/u)
  })

  it('a stalled stream deletes nothing; the next run takes the pair again', async () => {
    const m = await model()
    const a = randomBytes(300_000)
    const rev = await file(m, 'w:1.mov', a)
    await enrol(m)
    const id = node('A')
    await checked(rev, id, a)
    m.clouds.put('mega', mega(m, 'w:1.mov'), { bytes: a, id })
    const dup = node('A2')
    m.clouds.put('mega', mega(m, 'w-1.mov'), { bytes: a, id: dup, stallAfter: 64 * 1024 })

    const report = await run(m, true, { idleMs: 50 })
    expect(report).toMatchObject({ deleted: { files: 0 }, not_deleted: { stalled: 1 } })
    expect(m.clouds.writes).toEqual([])

    m.clouds.put('mega', mega(m, 'w-1.mov'), { bytes: a, id: dup })
    const again = await run(m, true)
    expect(again).toMatchObject({ deleted: { files: 1 } })
  })
})

describe('mega-dedupe: the fence', () => {
  const refused = (kind: string | null, path: string) => {
    try {
      assertWrite(kind, 'duplicate', path)
      return false
    } catch (error) {
      return error instanceof TransportError && error.code === 'refused'
    }
  }

  it('deletes only in MEGA under originals/, never a part, never elsewhere', () => {
    expect(refused('mega', 'originals/lora/yadisk/a-b.mov')).toBe(false)
    expect(refused('mega', 'originals/lora/yadisk/a.mov.co-part')).toBe(true)
    expect(refused('mega', 'other/a-b.mov')).toBe(true)
    expect(refused('mega', '../originals/a-b.mov')).toBe(true)
    expect(refused('dropbox', 'Архив Я.Диска/a-b.mov')).toBe(true)
    expect(refused('yandex', 'originals/lora/a-b.mov')).toBe(true)
    expect(refused(null, 'originals/lora/a-b.mov')).toBe(true)
  })

  it('takes only the node checked, never one the ledger keeps', async () => {
    const clouds = new FakeClouds()
    const path = 'originals/x/yadisk/a-b.mov'
    clouds.put('mega', path, { bytes: randomBytes(10), id: 'N1' })
    const target = (over: Partial<DuplicateTarget> = {}): DuplicateTarget => ({
      id: 'N1',
      size: 10,
      inLedger: async () => false,
      ...over,
    })
    await expect(clouds.removeDuplicate('mega', path, target({ id: 'N2' }))).rejects.toMatchObject({
      code: 'refused',
    })
    await expect(clouds.removeDuplicate('mega', path, target({ size: 9 }))).rejects.toMatchObject({
      code: 'refused',
    })
    await expect(
      clouds.removeDuplicate('mega', path, target({ inLedger: async () => true })),
    ).rejects.toMatchObject({ code: 'refused' })
    await expect(
      clouds.removeDuplicate('dropbox-x', 'Архив Я.Диска/a-b.mov', target()),
    ).rejects.toMatchObject({ code: 'refused' })
    expect(clouds.writes).toEqual([])
    await clouds.removeDuplicate('mega', path, target())
    expect(clouds.writes).toEqual([`remove-duplicate mega:${path}`])
    await expect(clouds.removeDuplicate('mega', path, target())).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('a path or node of the ledger is never deleted, whatever the caller says', async () => {
    const m = await model()
    const a = randomBytes(1_000)
    const rev = await file(m, 'k.mov', a)
    await enrol(m)
    await checked(rev, 'LEDGER-NODE', a)
    expect(await ledgerKeeps(db, 'mega', mega(m, 'k.mov'), 'OTHER')).toBe(true)
    expect(await ledgerKeeps(db, 'mega', mega(m, 'k-.mov'), 'LEDGER-NODE')).toBe(true)
    expect(await ledgerKeeps(db, 'mega', mega(m, 'k-.mov'), 'OTHER')).toBe(false)
  })

  it('rclone: a delete outside the fence is refused before rclone is asked anything', async () => {
    // No binary, no configuration: a delete that got past the path would fail, not be refused.
    const rclone = new RcloneTransport({ binary: '/nonexistent/rclone', config: '/nonexistent' })
    const target: DuplicateTarget = { id: 'N', size: 1, inLedger: async () => false }
    for (const [remote, path] of [
      ['dropbox-x', 'Архив Я.Диска/a.mov'],
      ['yadisk-x', 'disk/a/x.mov'],
      ['mega', 'other/a.mov'],
      ['mega', 'originals/a/x.mov.co-part'],
      ['mega', '/originals/a/x.mov'],
    ] as const) {
      await expect(rclone.removeDuplicate(remote, path, target)).rejects.toMatchObject({
        code: 'refused',
      })
    }
  })
})
