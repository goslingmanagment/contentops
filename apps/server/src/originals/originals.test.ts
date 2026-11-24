import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { systemTx } from '../media/testing'
import { type TestServer, testServer } from '../testing/server'
import { decodeText, parseCombined, parseManifest, parseMd5Sums, parseMegaListing } from './inputs'
import { type OriginalState, originalStates } from './rule'
import { nightLabel, seedOriginals } from './seed'
import { originalsStatus } from './status'

/**
 * The ledger of the places of the originals and its rule (SPEC §9.4, migration 0027): every
 * outcome of «решён», «надёжен» from two checked clouds, what drops a check, the seed from the
 * night's files — checked only when the MD5 is the revision's — and its repeat.
 */

let server: TestServer
let db: Db
let owner: string

beforeAll(async () => {
  server = await testServer()
  db = server.db
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM principals WHERE login = 'dmitriy'`)
  owner = rows[0]?.id as string
})
afterAll(() => server.close())

const sha = () => randomBytes(32)
const md5Of = (text: string) => createHash('md5').update(text).digest()

async function newModel(): Promise<string> {
  return systemTx(db, async (tx) => {
    const code = `m${randomUUID().slice(0, 8)}`
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO models (code, title, title_genitive) VALUES (${code}, ${code}, ${code})
      RETURNING id`)
    return rows[0]?.id as string
  })
}

async function codeOf(model: string): Promise<string> {
  const { rows } = await db.execute<{ code: string }>(sql`
    SELECT code FROM models WHERE id = ${model}::uuid`)
  return rows[0]?.code as string
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

interface FileOptions {
  size?: number
  md5?: Buffer
  contentHash?: Buffer
  /** The import read the bytes and they matched the hash of the cloud. */
  verified?: boolean
  /** The revision of this archive holds the file. */
  archive?: string
}

let entries = 0

/** A file of the source with its one revision; the path is relative to the root of the source. */
async function file(
  model: string,
  src: string,
  kind: 'yandex_disk' | 'dropbox',
  path: string,
  options: FileOptions = {},
): Promise<{ revision: string; sourceSha: Buffer }> {
  const sourceSha = sha()
  const full = kind === 'yandex_disk' ? `disk:/${path}` : `/${path}`
  return systemTx(db, async (tx) => {
    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name,
                                  archive_revision_id, archive_entry_no)
      VALUES (${model}::uuid, ${src}::uuid, ${`id:${randomUUID()}`}, ${full},
              ${path.slice(path.lastIndexOf('/') + 1)}, ${options.archive ?? null}::uuid,
              ${options.archive ? ++entries : null}::int)
      RETURNING id`)
    const object = objects[0]?.id as string
    const verified = options.verified === true
    const { rows: revisions } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size, md5,
                                    content_hash, remote_rev, source_sha256, verified_at,
                                    verified_route)
      VALUES (${model}::uuid, ${object}::uuid, 1, ${options.size ?? 100},
              ${kind === 'yandex_disk' && !options.archive ? (options.md5 ?? md5Of(path)) : null},
              ${kind === 'dropbox' ? (options.contentHash ?? sha()) : null},
              ${kind === 'dropbox' ? randomUUID().replaceAll('-', '') : null},
              ${verified ? sourceSha : null}, ${verified ? new Date() : null},
              ${verified ? 'download' : null})
      RETURNING id`)
    const revision = revisions[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${revision}::uuid WHERE id = ${object}::uuid`)
    return { revision, sourceSha }
  })
}

async function blob(state: 'present' | 'purged' = 'present', bytes = sha()): Promise<Buffer> {
  const hex = bytes.toString('hex')
  await systemTx(db, (tx) =>
    tx.execute(sql`
      INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key, state, purged_at)
      VALUES (${bytes}, 1, 'video/mp4', 'mp4', 'video', ${`blobs/sha256/${hex}.mp4`}, ${state},
              ${state === 'purged' ? new Date() : null})
      ON CONFLICT DO NOTHING`),
  )
  return bytes
}

/** An accepted version with its master; returns the version and its item. */
async function version(model: string, master: Buffer): Promise<{ version: string; item: string }> {
  return systemTx(db, async (tx) => {
    const { rows: items } = await tx.execute<{ id: string }>(sql`
      INSERT INTO content_items (model_id, type, number, origin)
      VALUES (${model}::uuid, 'CUS',
              (SELECT COALESCE(max(number), 0) + 1 FROM content_items WHERE model_id = ${model}::uuid),
              'manual')
      RETURNING id`)
    const item = items[0]?.id as string
    const asset = randomUUID()
    const id = randomUUID()
    await tx.execute(sql`
      INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id)
      VALUES (${model}::uuid, ${asset}::uuid, ${item}::uuid, 'video', ${id}::uuid)`)
    await tx.execute(sql`
      INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256)
      VALUES (${model}::uuid, ${id}::uuid, ${asset}::uuid, 1, ${master})`)
    return { version: id, item }
  })
}

interface DraftOptions {
  state?: 'ready' | 'resolved'
  outcome?: 'new_item' | 'alias' | 'rejected'
  master?: Buffer
  sourceSha?: Buffer
  blocked?: string
  rejectedBy?: string | null
  reason?: string | null
  duplicateOf?: string
  item?: string
}

async function draft(
  model: string,
  src: string,
  input: { revision?: string; upload?: string },
  options: DraftOptions = {},
): Promise<void> {
  await systemTx(db, async (tx) => {
    const { rows: groups } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (model_id, source_id, group_key, grouping)
      VALUES (${model}::uuid, ${src}::uuid, ${`g:${randomUUID()}`}, 'folder')
      RETURNING id`)
    await tx.execute(sql`
      INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, web_upload_id, origin,
                                state, outcome, source_sha256, master_sha256, master_verified_at,
                                blocked_reason, decided_by, reject_reason, rejected_at,
                                duplicate_of_version_id, applied_item_id)
      VALUES (${model}::uuid, ${groups[0]?.id}::uuid, ${input.revision ?? null}::uuid,
              ${input.upload ?? null}::uuid, ${input.upload ? 'web_upload' : 'disk_scan'},
              ${options.state ?? 'ready'}, ${options.outcome ?? null},
              ${options.sourceSha ?? null}, ${options.master ?? null},
              ${options.master ? new Date() : null}, ${options.blocked ?? null},
              ${options.rejectedBy ?? null}::uuid, ${options.reason ?? null},
              ${options.outcome === 'rejected' ? new Date() : null},
              ${options.duplicateOf ?? null}::uuid, ${options.item ?? null}::uuid)`)
  })
}

async function upload(model: string, bytes: Buffer): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO web_uploads (model_id, upload_id, principal_id, client_filename, declared_kind,
                               size_expected, bytes_received, sha256, state, tmp_key)
      VALUES (${model}::uuid, ${randomUUID()}, ${owner}::uuid, 'edit.mov', 'other', 500, 500,
              ${bytes}, 'registered', ${`inbox/web/${randomUUID()}`})
      RETURNING id`)
    return rows[0]?.id as string
  })
}

/** A checked copy of the original in a cloud. */
async function copy(
  model: string,
  original: { revision?: string; upload?: string },
  place: 'yandex' | 'dropbox' | 'mega',
  options: { verified?: boolean } = {},
): Promise<string> {
  const verified = options.verified !== false
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO original_copies (model_id, source_revision_id, web_upload_id, place, role, remote,
                                 path, object_ref, byte_size, seen_md5, verified_at, verified_by)
    VALUES (${model}::uuid, ${original.revision ?? null}::uuid, ${original.upload ?? null}::uuid,
            ${place}, 'copy', ${place}, ${`originals/${randomUUID()}`}, ${`node-${randomUUID()}`},
            100, ${verified ? md5Of('x') : null}, ${verified ? new Date() : null},
            ${verified ? 'test' : null})
    RETURNING id`)
  return rows[0]?.id as string
}

async function stateOf(model: string, id: string, members = false): Promise<OriginalState> {
  const state = (await originalStates(db, model, { members })).find((s) => s.id === id)
  if (!state) throw new Error(`no original ${id}`)
  return state
}

describe('«решён»: every outcome', () => {
  let model: string
  let src: string
  beforeAll(async () => {
    model = await newModel()
    src = await source(model, 'yandex_disk')
  })

  it('a master built and on our disk decides, accepted or not', async () => {
    const accepted = await file(model, src, 'yandex_disk', '1. PPV/a.mov', { verified: true })
    const master = await blob()
    const { item } = await version(model, master)
    await draft(
      model,
      src,
      { revision: accepted.revision },
      {
        state: 'resolved',
        outcome: 'new_item',
        master,
        sourceSha: accepted.sourceSha,
        item,
      },
    )
    const open = await file(model, src, 'yandex_disk', '1. PPV/b.mov', { verified: true })
    await draft(
      model,
      src,
      { revision: open.revision },
      { master: await blob(), sourceSha: open.sourceSha },
    )
    expect(await stateOf(model, accepted.revision)).toMatchObject({
      decided: true,
      reason: 'master',
      is_master: false,
    })
    expect(await stateOf(model, open.revision)).toMatchObject({ decided: true, reason: 'master' })
  })

  it('a master that is gone, a failed master, an open draft, a file not imported: not decided', async () => {
    const purged = await file(model, src, 'yandex_disk', '1. PPV/c.mov', { verified: true })
    await draft(
      model,
      src,
      { revision: purged.revision },
      { master: await blob('purged'), sourceSha: purged.sourceSha },
    )
    const failed = await file(model, src, 'yandex_disk', '1. PPV/d.mov', { verified: true })
    await draft(
      model,
      src,
      { revision: failed.revision },
      { blocked: 'master_failed', sourceSha: failed.sourceSha },
    )
    const waiting = await file(model, src, 'yandex_disk', '1. PPV/e.mov', { verified: true })
    await draft(model, src, { revision: waiting.revision }, { sourceSha: waiting.sourceSha })
    const later = await file(model, src, 'yandex_disk', '9. SMM/f.mov')
    expect(await stateOf(model, purged.revision)).toMatchObject({
      decided: false,
      reason: 'master_missing',
    })
    expect(await stateOf(model, failed.revision)).toMatchObject({
      decided: false,
      reason: 'master_failed',
    })
    expect(await stateOf(model, waiting.revision)).toMatchObject({
      decided: false,
      reason: 'ready',
    })
    expect(await stateOf(model, later.revision)).toMatchObject({
      decided: false,
      reason: 'not_imported',
    })
  })

  it('rejected by a person with a reason, an alias of accepted bytes: decided', async () => {
    const rejected = await file(model, src, 'yandex_disk', '8. Other/g.mov', { verified: true })
    await draft(
      model,
      src,
      { revision: rejected.revision },
      { state: 'resolved', outcome: 'rejected', rejectedBy: owner, reason: 'брак' },
    )
    const silent = await file(model, src, 'yandex_disk', '8. Other/h.mov', { verified: true })
    await draft(
      model,
      src,
      { revision: silent.revision },
      { state: 'resolved', outcome: 'rejected', rejectedBy: null, reason: null },
    )
    const alias = await file(model, src, 'yandex_disk', '8. Other/i.mov', { verified: true })
    const { version: target } = await version(model, await blob())
    await draft(
      model,
      src,
      { revision: alias.revision },
      { state: 'resolved', outcome: 'alias', duplicateOf: target },
    )
    const lost = await file(model, src, 'yandex_disk', '8. Other/j.mov', { verified: true })
    const { version: lostTarget } = await version(model, await blob('purged'))
    await draft(
      model,
      src,
      { revision: lost.revision },
      { state: 'resolved', outcome: 'alias', duplicateOf: lostTarget },
    )
    expect(await stateOf(model, rejected.revision)).toMatchObject({
      decided: true,
      reason: 'rejected',
    })
    expect(await stateOf(model, silent.revision)).toMatchObject({
      decided: false,
      reason: 'resolved:rejected',
    })
    expect(await stateOf(model, alias.revision)).toMatchObject({ decided: true, reason: 'alias' })
    expect(await stateOf(model, lost.revision)).toMatchObject({
      decided: false,
      reason: 'resolved:alias',
    })
  })

  it('not media and not content by the import rules decide without a draft', async () => {
    const notes = await file(model, src, 'yandex_disk', '5. Sextings/notes.txt')
    const refs = await file(model, src, 'yandex_disk', '8. Other/не контент/k.jpg')
    expect(await stateOf(model, notes.revision)).toMatchObject({
      decided: true,
      reason: 'import_rule',
    })
    expect(await stateOf(model, refs.revision)).toMatchObject({
      decided: true,
      reason: 'import_rule',
    })
  })

  it('an archive decides when all its members do; one not unpacked waits', async () => {
    const done = await file(model, src, 'yandex_disk', '5. Sextings/done.zip', { verified: true })
    const inside = await file(model, src, 'yandex_disk', '5. Sextings/done.zip/1.jpg', {
      archive: done.revision,
      verified: true,
    })
    await draft(
      model,
      src,
      { revision: inside.revision },
      { master: await blob(), sourceSha: inside.sourceSha },
    )
    await file(model, src, 'yandex_disk', '5. Sextings/done.zip/read me.txt', {
      archive: done.revision,
    })
    const open = await file(model, src, 'yandex_disk', '5. Sextings/open.zip', { verified: true })
    await file(model, src, 'yandex_disk', '5. Sextings/open.zip/2.jpg', { archive: open.revision })
    const packed = await file(model, src, 'yandex_disk', '5. Sextings/packed.zip')
    expect(await stateOf(model, done.revision)).toMatchObject({ decided: true, reason: 'archive' })
    expect(await stateOf(model, open.revision)).toMatchObject({
      decided: false,
      reason: 'archive_members',
    })
    expect(await stateOf(model, packed.revision)).toMatchObject({
      decided: false,
      reason: 'not_imported',
    })
    // Members are not originals of their own: only with `members`.
    expect((await originalStates(db, model)).some((s) => s.id === inside.revision)).toBe(false)
    expect(await stateOf(model, inside.revision, true)).toMatchObject({ member: true })
  })

  it('a web upload that is its own master is never releasable; one with a master of its own is', async () => {
    const own = await blob()
    const self = await upload(model, own)
    const { item } = await version(model, own)
    await draft(
      model,
      src,
      { upload: self },
      { state: 'resolved', outcome: 'new_item', master: own, sourceSha: own, item },
    )
    const raw = await blob()
    const edited = await upload(model, raw)
    const master = await blob()
    const { item: other } = await version(model, master)
    await draft(
      model,
      src,
      { upload: edited },
      { state: 'resolved', outcome: 'new_item', master, sourceSha: raw, item: other },
    )
    for (const original of [self, edited]) {
      await copy(model, { upload: original }, 'mega')
      await copy(model, { upload: original }, 'dropbox')
    }
    expect(await stateOf(model, self)).toMatchObject({
      holder: 'web_upload',
      reliable: true,
      decided: true,
      is_master: true,
      releasable: false,
    })
    expect(await stateOf(model, edited)).toMatchObject({
      reliable: true,
      decided: true,
      is_master: false,
      releasable: true,
    })
  })
})

describe('«надёжен»: two clouds, checked, seen', () => {
  let model: string
  let src: string
  let revision: string
  beforeAll(async () => {
    model = await newModel()
    src = await source(model, 'yandex_disk')
    const made = await file(model, src, 'yandex_disk', '1. PPV/a.mov', { verified: true })
    revision = made.revision
    await draft(model, src, { revision }, { master: await blob(), sourceSha: made.sourceSha })
  })

  it('one cloud is not enough; an unchecked second neither; two checked are', async () => {
    const mega = await copy(model, { revision }, 'mega')
    expect(await stateOf(model, revision)).toMatchObject({
      places: 1,
      reliable: false,
      releasable: false,
    })
    const dropbox = await copy(model, { revision }, 'dropbox', { verified: false })
    expect(await stateOf(model, revision)).toMatchObject({ places: 1, reliable: false })
    await db.execute(sql`
      UPDATE original_copies SET verified_at = now(), verified_by = 'test', seen_md5 = ${md5Of('x')}
       WHERE id = ${dropbox}::uuid`)
    expect(await stateOf(model, revision)).toMatchObject({
      places: 2,
      reliable: true,
      decided: true,
      releasable: true,
    })
    expect(mega).toBeTruthy()
  })

  it('a cloud where the object went missing does not count', async () => {
    await db.execute(sql`
      UPDATE original_copies SET missing_since = now()
       WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
    expect(await stateOf(model, revision)).toMatchObject({ places: 1, reliable: false })
    await db.execute(sql`
      UPDATE original_copies SET missing_since = NULL
       WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
    expect(await stateOf(model, revision)).toMatchObject({ places: 2, reliable: true })
  })

  it('another node under the path or another size drops the check', async () => {
    await db.execute(sql`
      UPDATE original_copies SET object_ref = 'node-new'
       WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
    const { rows } = await db.execute<{ verified_at: string | null; seen_md5: string | null }>(sql`
      SELECT verified_at, seen_md5 FROM original_copies
       WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
    expect(rows[0]).toEqual({ verified_at: null, seen_md5: null })
    expect(await stateOf(model, revision)).toMatchObject({ places: 1, reliable: false })
    await db.execute(sql`
      UPDATE original_copies SET byte_size = 101
       WHERE source_revision_id = ${revision}::uuid AND place = 'dropbox'`)
    expect(await stateOf(model, revision)).toMatchObject({ places: 0, reliable: false })
    // A new check in the same statement keeps itself.
    await db.execute(sql`
      UPDATE original_copies SET object_ref = 'node-newer', verified_at = now(),
             verified_by = 'test', seen_md5 = ${md5Of('x')}
       WHERE source_revision_id = ${revision}::uuid AND place = 'mega'`)
    expect(await stateOf(model, revision)).toMatchObject({ places: 1 })
  })

  it('a check without the object it saw or a hash of the bytes is refused', async () => {
    const other = await file(model, src, 'yandex_disk', '1. PPV/b.mov')
    await expect(
      db.execute(sql`
        INSERT INTO original_copies (model_id, source_revision_id, place, role, remote, path,
                                     byte_size, verified_at, verified_by)
        VALUES (${model}::uuid, ${other.revision}::uuid, 'mega', 'copy', 'mega', 'x', 1, now(),
                'test')`),
    ).rejects.toMatchObject({ cause: { constraint: 'original_copies_verified' } })
    await expect(
      db.execute(sql`
        INSERT INTO original_copies (model_id, source_revision_id, place, role, path)
        VALUES (${model}::uuid, ${other.revision}::uuid, 'mega', 'origin', 'x')`),
    ).rejects.toMatchObject({ cause: { constraint: 'original_copies_origin' } })
  })
})

describe('ops.js originals seed', () => {
  let model: string
  let code: string
  let dir: string
  let listing: string
  const checkedAt = new Date('2026-11-24T00:56:59Z')
  const before = '2026-11-20T10:00:00Z'
  const after = '2026-11-24T02:00:00Z'
  const files: Record<string, { revision: string; md5: Buffer; size: number }> = {}

  beforeAll(async () => {
    model = await newModel()
    code = await codeOf(model)
    const src = await source(model, 'yandex_disk')
    // P — checked and the same; Q — Я.Диск gives another MD5 than the snapshot; R — the node
    // appeared after the check; S — another size in MEGA; T — the check says the bytes differ;
    // U — imported but not in MEGA.
    for (const [name, size] of [
      ['P', 10],
      ['Q', 20],
      ['R', 30],
      ['S', 40],
      ['T', 50],
      ['U', 60],
    ] as const) {
      const path = `1. PPV/${name}.mov`
      const md5 = md5Of(name)
      const made = await file(model, src, 'yandex_disk', path, { size, md5, verified: true })
      files[name] = { revision: made.revision, md5, size }
      await draft(
        model,
        src,
        { revision: made.revision },
        { master: await blob(), sourceSha: made.sourceSha },
      )
    }
    dir = await mkdtemp(join(tmpdir(), 'originals-seed-'))
    const node = (name: string, size: number, modTime: string) => ({
      Path: `1. PPV/${name}.mov`,
      Name: `${name}.mov`,
      Size: size,
      MimeType: 'video/quicktime',
      ModTime: modTime,
      IsDir: false,
      ID: `node-${name}`,
    })
    listing = join(dir, 'mega.json')
    // As PowerShell may write it: a BOM and CRLF.
    await writeFile(
      listing,
      `﻿[\r\n${[
        node('P', 10, before),
        node('Q', 20, before),
        node('R', 30, after),
        node('S', 41, before),
        node('T', 50, before),
        node('Unknown', 5, before),
      ]
        .map((entry) => JSON.stringify(entry))
        .join(',\r\n')}\r\n]\r\n`,
    )
    const verify = join(dir, 'verify')
    await mkdir(verify)
    const hex = (name: string) => md5Of(name).toString('hex')
    await writeFile(
      join(verify, '1. PPV.ya.md5'),
      [
        `${hex('P')}  P.mov`,
        `${hex('Q-changed')}  Q.mov`,
        `${hex('R')}  R.mov`,
        `${hex('S')}  S.mov`,
        `${hex('T')}  T.mov`,
        '',
      ].join('\n'),
    )
    await utimes(join(verify, '1. PPV.ya.md5'), checkedAt, checkedAt)
    await writeFile(
      join(verify, '1. PPV.combined'),
      ['= P.mov', '= Q.mov', '= R.mov', '= S.mov', '* T.mov', ''].join('\n'),
    )
  })

  const megaRow = async (name: string) => {
    const { rows } = await db.execute<{
      object_ref: string
      verified_by: string | null
      verified_at: string | null
    }>(sql`
      SELECT object_ref, verified_by, verified_at::text FROM original_copies
       WHERE source_revision_id = ${files[name]?.revision}::uuid AND place = 'mega'`)
    return rows[0]
  }

  it('without --yes counts and writes nothing', async () => {
    const report = await seedOriginals(db, {
      model: code,
      mega: listing,
      checks: join(dir, 'verify'),
      write: false,
    })
    expect(report).toMatchObject({ written: false, origins: { rows: 6, inserted: 6 } })
    const { rows } = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM original_copies WHERE model_id = ${model}::uuid`)
    expect(rows[0]?.n).toBe('0')
  })

  it('checks a MEGA copy only when its MD5 is the revision’s, the size is and the node is older', async () => {
    const report = await seedOriginals(db, {
      model: code,
      mega: listing,
      checks: join(dir, 'verify'),
      write: true,
    })
    expect(report).toMatchObject({
      written: true,
      origins: { rows: 6, checked: 6, inserted: 6, updated: 0 },
      mega: {
        listed: 6,
        matched: 5,
        not_in_catalog: 1,
        checked: 1,
        unchecked: {
          md5_not_of_revision: 1,
          node_newer_than_check: 1,
          size_differs: 1,
          'check:*': 1,
        },
        inserted: 5,
        updated: 0,
      },
      checks: { roots: 1, lines: 5, same: 4 },
    })
    expect(await megaRow('P')).toMatchObject({
      object_ref: 'node-P',
      verified_by: nightLabel(checkedAt),
    })
    expect(nightLabel(checkedAt)).toBe('night-24.11')
    for (const name of ['Q', 'R', 'S', 'T']) {
      expect(await megaRow(name)).toMatchObject({ verified_at: null })
    }
    expect(await megaRow('U')).toBeUndefined()
    // P lives in Я.Диск (the import read it) and in MEGA (the night's check): it may go.
    expect(await stateOf(model, files.P?.revision as string)).toMatchObject({
      places: 2,
      reliable: true,
      decided: true,
      releasable: true,
    })
    expect(await stateOf(model, files.Q?.revision as string)).toMatchObject({
      places: 1,
      releasable: false,
    })
    const { rows: journal } = await db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM action_log
       WHERE model_id = ${model}::uuid AND action = 'originals.seed'`)
    expect(journal[0]?.n).toBe('1')
  })

  it('a repeat changes no row', async () => {
    const { rows: before } = await db.execute(sql`
      SELECT to_jsonb(c.*) AS row FROM original_copies c
       WHERE model_id = ${model}::uuid ORDER BY id`)
    const report = await seedOriginals(db, {
      model: code,
      mega: listing,
      checks: join(dir, 'verify'),
      write: true,
    })
    expect(report.origins).toMatchObject({ inserted: 0, updated: 0 })
    expect(report.mega).toMatchObject({ inserted: 0, updated: 0, checked: 1 })
    const { rows: again } = await db.execute(sql`
      SELECT to_jsonb(c.*) AS row FROM original_copies c
       WHERE model_id = ${model}::uuid ORDER BY id`)
    expect(again).toEqual(before)
  })

  it('a new node under the path drops the seeded check, a later listing too', async () => {
    const replaced = join(dir, 'mega-later.json')
    await writeFile(
      replaced,
      JSON.stringify([
        {
          Path: '1. PPV/P.mov',
          Size: 10,
          ModTime: after,
          IsDir: false,
          ID: 'node-P2',
        },
      ]),
    )
    const report = await seedOriginals(db, {
      model: code,
      mega: replaced,
      checks: join(dir, 'verify'),
      write: true,
    })
    expect(report.mega).toMatchObject({ checked: 0, updated: 1 })
    expect(await megaRow('P')).toMatchObject({ object_ref: 'node-P2', verified_at: null })
    expect(await stateOf(model, files.P?.revision as string)).toMatchObject({
      places: 1,
      reliable: false,
    })
  })

  it('status counts the rule per model and the ledger per cloud', async () => {
    const [status] = await originalsStatus(db, code)
    expect(status).toMatchObject({
      model: code,
      totals: { originals: 6, decided: 6, reliable: 0, releasable: 0 },
      holders: { yandex_disk: { originals: 6 } },
      places: {
        yandex: { rows: 6, checked: 6 },
        mega: { rows: 5, checked: 0 },
      },
    })
  })

  it('Ari’s manifest: copies in MEGA for her Dropbox files, unchecked, by path in any case', async () => {
    const ari = await newModel()
    const ariCode = await codeOf(ari)
    const src = await source(ari, 'dropbox')
    const a = await file(ari, src, 'dropbox', '2. FYP/Clip.MOV', { size: 70, verified: true })
    const b = await file(ari, src, 'dropbox', '1. PPV/pack/1.jpg', { size: 80 })
    const manifest = join(dir, 'ari-manifest.tsv')
    await writeFile(
      manifest,
      [
        '2. fyp/clip.mov\tFYP/FYP-001.mov\t70\tcatalog',
        '2. FYP/Clip.MOV\tКопии/clip.mov\t70\tcopy',
        '1. PPV/pack/1.jpg\tPPV/PPV-001_pic01.jpg\t81\tcatalog',
        'gone.mov\tВне каталога/gone.mov\t5\toutside',
        '',
      ].join('\r\n'),
    )
    const report = await seedOriginals(db, { model: ariCode, manifest, write: true })
    expect(report).toMatchObject({
      origins: { rows: 2, checked: 1, inserted: 2 },
      manifest: {
        lines: 4,
        matched: 1,
        not_in_catalog: 1,
        size_differs: 1,
        duplicates: 1,
        inserted: 1,
      },
    })
    const { rows } = await db.execute<{ path: string; verified_at: string | null }>(sql`
      SELECT path, verified_at::text FROM original_copies
       WHERE source_revision_id = ${a.revision}::uuid AND place = 'mega'`)
    expect(rows).toEqual([{ path: `originals/${ariCode}/FYP/FYP-001.mov`, verified_at: null }])
    expect(await stateOf(ari, a.revision)).toMatchObject({ places: 1, reliable: false })
    expect(await stateOf(ari, b.revision)).toMatchObject({ places: 0 })
    const again = await seedOriginals(db, { model: ariCode, manifest, write: true })
    expect(again.manifest).toMatchObject({ inserted: 0, updated: 0 })
    expect(again.origins).toMatchObject({ inserted: 0, updated: 0 })
  })
})

describe('the files of the seed', () => {
  it('read a BOM, UTF-16 and CRLF', () => {
    expect(decodeText(Buffer.from('﻿a\r\nb\r\n'))).toBe('a\nb\n')
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('я\r\n', 'utf16le')])
    expect(decodeText(utf16)).toBe('я\n')
  })

  it('parse the sums, the check, the listing and the manifest', () => {
    const md5 = 'd41d8cd98f00b204e9800998ecf8427e'
    expect([...parseMd5Sums(`${md5}  a b.mov\n${md5.toUpperCase()} *c.mov\nnoise\n`)]).toEqual([
      ['a b.mov', md5],
      ['c.mov', md5],
    ])
    expect(parseCombined('= a.mov\n* b.mov\n+ c.mov\n! d.mov\n- e.mov\n?? f\n')).toEqual([
      { mark: '=', path: 'a.mov' },
      { mark: '*', path: 'b.mov' },
      { mark: '+', path: 'c.mov' },
      { mark: '!', path: 'd.mov' },
      { mark: '-', path: 'e.mov' },
    ])
    expect(
      parseMegaListing(
        '[{"Path":"d","IsDir":true},{"Path":"d/x.mov","Size":3,"ModTime":"2026-11-23T21:13:04.123456789Z","IsDir":false,"ID":"N1"}]',
      ),
    ).toEqual([{ path: 'd/x.mov', size: 3, modTime: '2026-11-23T21:13:04.123Z', id: 'N1' }])
    expect(parseManifest('a.mov\tPPV/a.mov\t12\tcatalog\n')).toEqual([
      { dropbox: 'a.mov', mega: 'PPV/a.mov', size: 12, kind: 'catalog' },
    ])
    expect(() => parseManifest('a.mov\tPPV/a.mov\n')).toThrow(/line 1/)
  })
})
