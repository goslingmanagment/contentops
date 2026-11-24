import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { OriginalsVmFreedSchema } from '@contentops/contracts/domain/originals'
import { enqueueWork } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { stagedAhead } from '../intake/fetch'
import { sweepStaging } from '../intake/staging'
import { type BlobStore, blobKey } from '../media/storage'
import { systemTx, tempStore } from '../media/testing'
import { addPerson, call, OWNER, signIn, type TestServer, testServer } from '../testing/server'
import { MODEL_CONFIG_KEY } from './config'
import { type FreeReport, freeOriginals, vmFreed } from './free'
import { HOLD_KEY, stagingState } from './hold'
import { setOriginalsSwitch } from './work'

/**
 * What leaves the VM's disk (SPEC §9.1, §9.4, migration 0030): a web upload goes only when both
 * its copies are checked — rejected and alias ones too; its draft then gives its master; a master's
 * bytes and derivatives never go; the inputs of unfinished works and the previews a draft still
 * shows hold the bytes; an unreferenced blob goes only when its original is known and reliable;
 * the staging is held until the original is reliable, within the budget, the hours and the bytes,
 * and only with the switch on and never for the import of the old corpus. A second run changes
 * nothing.
 */

let server: TestServer
let db: TestServer['db']
let store: BlobStore
let owner: string

beforeAll(async () => {
  server = await testServer()
  db = server.db
  store = await tempStore('free')
  await setOriginalsSwitch(db, true)
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT id FROM principals WHERE login = 'dmitriy'`)
  owner = rows[0]?.id as string
})
afterAll(() => server.close())

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const hex = (value: string) => Buffer.from(value, 'hex')

/** A model the works look at (the only one: the others lose their configuration). */
async function newModel(): Promise<string> {
  return systemTx(db, async (tx) => {
    const code = `f${randomUUID().slice(0, 8)}`
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO models (code, title, title_genitive) VALUES (${code}, ${code}, ${code})
      RETURNING id`)
    const id = rows[0]?.id as string
    await tx.execute(sql`
      UPDATE policy_settings SET value = NULL WHERE key = ${MODEL_CONFIG_KEY} AND value IS NOT NULL`)
    await tx.execute(sql`
      INSERT INTO policy_settings (model_id, key, value)
      VALUES (${id}::uuid, ${MODEL_CONFIG_KEY},
              ${JSON.stringify({
                dropbox: 'dropbox-f:',
                mega: 'mega:originals/f',
                copies: { dropbox: 'dropbox' },
                exclude: { dropbox: ['Загрузки ContentOps'] },
              })}::jsonb)`)
    return id
  })
}

async function source(model: string, kind: 'dropbox' | 'web_upload'): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      kind === 'dropbox'
        ? sql`
      INSERT INTO sources (model_id, kind, label, root_path, credentials_ref)
      VALUES (${model}::uuid, 'dropbox', ${`dropbox ${randomUUID().slice(0, 6)}`}, '', 'TOKEN')
      RETURNING id`
        : sql`
      INSERT INTO sources (model_id, kind, label, read_only, enabled)
      VALUES (${model}::uuid, 'web_upload', 'Веб-загрузка', false, true)
      RETURNING id`,
    )
    return rows[0]?.id as string
  })
}

/** Bytes on our disk as a present blob; returns its SHA-256. */
async function blob(bytes: Uint8Array = randomBytes(2_000)): Promise<string> {
  const sha = sha256(bytes)
  const key = blobKey(sha, 'mov')
  await mkdir(dirname(store.path(key)), { recursive: true })
  await writeFile(store.path(key), bytes)
  await systemTx(db, (tx) =>
    tx.execute(sql`
      INSERT INTO blobs (sha256, byte_size, mime, ext, media_kind, storage_key, state)
      VALUES (${hex(sha)}, ${bytes.length}, 'video/quicktime', 'mov', 'video', ${key}, 'present')
      ON CONFLICT DO NOTHING`),
  )
  return sha
}

async function blobState(sha: string): Promise<{ state: string; file: boolean }> {
  const { rows } = await db.execute<{ state: string; storage_key: string }>(sql`
    SELECT state, storage_key FROM blobs WHERE sha256 = ${hex(sha)}`)
  const row = rows[0]
  if (!row) throw new Error(`no blob ${sha}`)
  return { state: row.state, file: await store.exists(row.storage_key) }
}

async function referenced(sha: string): Promise<boolean> {
  const { rows } = await db.execute<{ held: boolean }>(sql`
    SELECT blob_is_referenced(${hex(sha)}) AS held`)
  return rows[0]?.held === true
}

interface DraftOptions {
  state?: 'processing' | 'ready' | 'resolved'
  outcome?: 'new_item' | 'alias' | 'rejected'
  master?: string | null
  duplicateOf?: string
  origin?: 'web_upload' | 'disk_scan' | 'legacy_import'
  verifiedAt?: Date
}

async function draft(
  model: string,
  src: string,
  original: { upload?: string; revision?: string },
  sourceSha: string,
  options: DraftOptions = {},
): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows: groups } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (model_id, source_id, group_key, grouping)
      VALUES (${model}::uuid, ${src}::uuid, ${`g:${randomUUID()}`}, 'manual')
      RETURNING id`)
    const master = options.master ?? null
    const rejected = options.outcome === 'rejected'
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_drafts (model_id, group_id, web_upload_id, source_revision_id, origin, state,
                                outcome, byte_size, source_sha256, source_blob_sha256,
                                master_sha256, master_verified_at, decided_by, reject_reason,
                                rejected_at, duplicate_of_version_id)
      VALUES (${model}::uuid, ${groups[0]?.id}::uuid, ${original.upload ?? null}::uuid,
              ${original.revision ?? null}::uuid,
              ${options.origin ?? (original.upload ? 'web_upload' : 'disk_scan')},
              ${options.state ?? 'ready'}, ${options.outcome ?? null}, 2000, ${hex(sourceSha)},
              ${original.upload ? hex(sourceSha) : null}, ${master ? hex(master) : null},
              ${master ? (options.verifiedAt ?? new Date()) : null},
              ${rejected ? owner : null}::uuid, ${rejected ? 'брак' : null},
              ${rejected ? new Date() : null}, ${options.duplicateOf ?? null}::uuid)
      RETURNING id`)
    return rows[0]?.id as string
  })
}

/** A registered web upload of these bytes. */
async function upload(model: string, sha: string, name = 'clip.mov'): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO web_uploads (model_id, upload_id, principal_id, client_filename, declared_kind,
                               size_expected, bytes_received, sha256, state, tmp_key)
      VALUES (${model}::uuid, ${randomUUID()}, ${owner}::uuid, ${name}, 'other', 2000, 2000,
              ${hex(sha)}, 'registered', ${`inbox/web/${randomUUID()}`})
      RETURNING id`)
    return rows[0]?.id as string
  })
}

/** A revision of the model's Dropbox whose bytes our import read. */
async function revision(model: string, src: string, sha: string): Promise<string> {
  return systemTx(db, async (tx) => {
    const name = `${randomUUID().slice(0, 8)}.mov`
    const { rows: objects } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      VALUES (${model}::uuid, ${src}::uuid, ${`id:${randomUUID()}`}, ${`/New/${name}`}, ${name})
      RETURNING id`)
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size,
                                    content_hash, remote_rev, source_sha256, verified_at,
                                    verified_route)
      VALUES (${model}::uuid, ${objects[0]?.id}::uuid, 1, 2000, ${randomBytes(32)},
              ${randomUUID().replaceAll('-', '')}, ${hex(sha)}, now(), 'download')
      RETURNING id`)
    const id = rows[0]?.id as string
    await tx.execute(sql`
      UPDATE source_objects SET current_revision_id = ${id}::uuid
       WHERE id = ${objects[0]?.id}::uuid`)
    return id
  })
}

/** A row of the ledger: a copy (or the origin) in a cloud, checked unless said otherwise. */
async function place(
  model: string,
  original: { upload?: string; revision?: string },
  where: 'mega' | 'dropbox',
  options: { checked?: boolean; missing?: boolean; role?: 'origin' | 'copy' } = {},
): Promise<string> {
  const checked = options.checked !== false
  const role = options.role ?? 'copy'
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO original_copies (model_id, source_revision_id, web_upload_id, place, role, remote,
                                 path, object_ref, byte_size, seen_sha256, verified_at,
                                 verified_by, missing_since)
    VALUES (${model}::uuid, ${original.revision ?? null}::uuid, ${original.upload ?? null}::uuid,
            ${where}, ${role}, ${role === 'origin' ? null : `${where}-f`},
            ${`Загрузки ContentOps/2026-11/${randomUUID()}.mov`},
            ${checked ? `node-${randomUUID()}` : null}, ${checked ? 2000 : null},
            ${checked ? randomBytes(32) : null}, ${checked ? new Date() : null},
            ${checked ? 'worker:originals' : null}, ${options.missing ? new Date() : null})
    RETURNING id`)
  return rows[0]?.id as string
}

async function check(id: string): Promise<void> {
  await db.execute(sql`
    UPDATE original_copies
       SET object_ref = ${`node-${randomUUID()}`}, byte_size = 2000, seen_sha256 = ${randomBytes(32)},
           verified_at = now(), verified_by = 'worker:originals', missing_since = NULL
     WHERE id = ${id}::uuid`)
}

/** An accepted version whose master is these bytes. */
async function version(model: string, master: string): Promise<string> {
  return systemTx(db, async (tx) => {
    const { rows: items } = await tx.execute<{ id: string }>(sql`
      INSERT INTO content_items (model_id, type, number, origin)
      VALUES (${model}::uuid, 'CUS',
              (SELECT COALESCE(max(number), 0) + 1 FROM content_items WHERE model_id = ${model}::uuid),
              'manual')
      RETURNING id`)
    const asset = randomUUID()
    const id = randomUUID()
    await tx.execute(sql`
      INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id)
      VALUES (${model}::uuid, ${asset}::uuid, ${items[0]?.id}::uuid, 'video', ${id}::uuid)`)
    await tx.execute(sql`
      INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256)
      VALUES (${model}::uuid, ${id}::uuid, ${asset}::uuid, 1, ${hex(master)})`)
    return id
  })
}

async function uploadRow(id: string) {
  const { rows } = await db.execute<{ released: boolean; archive: string | null }>(sql`
    SELECT raw_released_at IS NOT NULL AS released, raw_archive_ref AS archive
      FROM web_uploads WHERE id = ${id}::uuid`)
  return rows[0]
}

async function draftSource(id: string): Promise<string | null> {
  const { rows } = await db.execute<{ sha: string | null }>(sql`
    SELECT encode(source_blob_sha256, 'hex') AS sha FROM inbox_drafts WHERE id = ${id}::uuid`)
  return rows[0]?.sha ?? null
}

const free = (): Promise<FreeReport> => freeOriginals(db, store)
const NOTHING = { released: 0, drafts_on_master: 0, removed: 0, removed_bytes: 0 }

describe('a web upload leaves the VM', () => {
  it('only with both its copies checked; the draft then gives its master; once', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    const raw = await blob()
    const master = await blob()
    const id = await upload(model, raw, 'Финал.mov')
    const draftId = await draft(model, web, { upload: id }, raw, { master })

    // No copy, one copy, a second one not checked yet, a second one missing: held.
    expect(await free()).toMatchObject(NOTHING)
    await place(model, { upload: id }, 'mega')
    expect(await free()).toMatchObject(NOTHING)
    const box = await place(model, { upload: id }, 'dropbox', { checked: false })
    expect(await free()).toMatchObject(NOTHING)
    await check(box)
    await db.execute(sql`UPDATE original_copies SET missing_since = now() WHERE id = ${box}::uuid`)
    expect(await free()).toMatchObject(NOTHING)
    expect(await referenced(raw)).toBe(true)
    expect(await blobState(raw)).toEqual({ state: 'present', file: true })

    await check(box)
    expect(await free()).toMatchObject({
      released: 1,
      drafts_on_master: 1,
      removed: 1,
      removed_bytes: 2000,
    })
    const row = await uploadRow(id)
    expect(row?.released).toBe(true)
    expect(JSON.parse(row?.archive ?? '{}')).toMatchObject({
      sha256: raw,
      copies: [{ place: 'dropbox' }, { place: 'mega' }],
    })
    expect(await draftSource(draftId)).toBeNull()
    expect(await blobState(raw)).toEqual({ state: 'purged', file: false })
    expect(await blobState(master)).toEqual({ state: 'present', file: true })

    // In the journal, as `worker:originals`; the storage operation is its own.
    const { rows: log } = await db.execute<{ action: string; actor_label: string }>(sql`
      SELECT action, actor_label FROM action_log
       WHERE model_id = ${model}::uuid AND action LIKE 'originals.%' AND entry_kind = 'action'
       ORDER BY id`)
    expect(log).toEqual([
      { action: 'originals.release', actor_label: 'worker:originals' },
      { action: 'originals.remove', actor_label: 'worker:originals' },
    ])
    const { rows: ops } = await db.execute<{ owner: string; state: string }>(sql`
      SELECT owner, state FROM storage_operations WHERE blob_sha256 = ${hex(raw)}`)
    expect(ops).toEqual([
      { owner: expect.stringMatching(/^worker:originals:/), state: 'committed' },
    ])
    expect((await vmFreed(db)).originals_bytes).toBeGreaterThanOrEqual(2000)

    // A second run changes nothing.
    const entries = async () => {
      const { rows } = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM action_log WHERE model_id = ${model}::uuid`)
      return rows[0]?.n
    }
    const before = await entries()
    expect(await free()).toMatchObject(NOTHING)
    expect(await entries()).toBe(before)
  })

  it('a rejected or alias upload is held until both its copies are checked', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    const accepted = await version(model, await blob())
    for (const outcome of ['rejected', 'alias'] as const) {
      const raw = await blob()
      const id = await upload(model, raw)
      await draft(model, web, { upload: id }, raw, {
        state: 'resolved',
        outcome,
        ...(outcome === 'alias' ? { duplicateOf: accepted } : {}),
      })
      // 0026 let these go at once, with no copy anywhere.
      expect(await referenced(raw), outcome).toBe(true)
      await place(model, { upload: id }, 'mega')
      expect(await free(), outcome).toMatchObject(NOTHING)
      await place(model, { upload: id }, 'dropbox')
      expect(await free(), outcome).toMatchObject({ released: 1, drafts_on_master: 0, removed: 1 })
      expect(await blobState(raw)).toEqual({ state: 'purged', file: false })
    }
  })

  it('an upload whose bytes are the master, or still without one, stays', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    // Uploaded into an object: the bytes are the master (accepted, and still a draft).
    const asMaster = await blob()
    const accepted = await upload(model, asMaster)
    await version(model, asMaster)
    await draft(model, web, { upload: accepted }, asMaster, { master: asMaster })
    const ready = await blob()
    const readyUpload = await upload(model, ready)
    const readyDraft = await draft(model, web, { upload: readyUpload }, ready, { master: ready })
    // «Другое» still being compressed.
    const raw = await blob()
    const pending = await upload(model, raw)
    const pendingDraft = await draft(model, web, { upload: pending }, raw, { state: 'processing' })
    for (const id of [accepted, readyUpload, pending]) {
      await place(model, { upload: id }, 'mega')
      await place(model, { upload: id }, 'dropbox')
    }

    expect(await free()).toMatchObject(NOTHING)
    for (const sha of [asMaster, ready, raw]) {
      expect(await blobState(sha)).toEqual({ state: 'present', file: true })
    }
    expect(await draftSource(readyDraft)).toBe(ready)
    expect(await draftSource(pendingDraft)).toBe(raw)
    expect((await uploadRow(accepted))?.released).toBe(false)
  })

  it('an unfinished work reading the bytes holds them until it ends', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    const raw = await blob()
    const id = await upload(model, raw)
    await draft(model, web, { upload: id }, raw, { state: 'resolved', outcome: 'rejected' })
    await place(model, { upload: id }, 'mega')
    await place(model, { upload: id }, 'dropbox')
    const { work } = await enqueueWork(db, {
      modelId: model,
      kind: 'encode_master',
      workKey: `encode:${randomUUID()}`,
      inputSha256: hex(raw),
    })

    expect(await free()).toMatchObject({ released: 1, removed: 0 })
    expect(await blobState(raw)).toEqual({ state: 'present', file: true })

    await systemTx(db, (tx) =>
      tx.execute(sql`
        UPDATE work_operations SET state = 'failed', finished_at = now()
         WHERE id = ${work.id}::uuid`),
    )
    expect(await free()).toMatchObject({ released: 0, removed: 1 })
    expect(await blobState(raw)).toEqual({ state: 'purged', file: false })
  })

  it('the derivatives of the master stay; previews a draft still shows hold the source', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    const raw = await blob()
    const master = await blob()
    const id = await upload(model, raw)
    await draft(model, web, { upload: id }, raw, { master })
    // Built from the source at intake and bound to the master after its check.
    const bound = await generation(raw, master)
    await place(model, { upload: id }, 'mega')
    await place(model, { upload: id }, 'dropbox')

    // A second upload whose preview was never bound: the draft still shows it.
    const raw2 = await blob()
    const id2 = await upload(model, raw2)
    await draft(model, web, { upload: id2 }, raw2, { master: await blob() })
    const unbound = await generation(raw2, null)
    await place(model, { upload: id2 }, 'mega')
    await place(model, { upload: id2 }, 'dropbox')

    expect(await free()).toMatchObject({ released: 2, removed: 1, kept: { previews: 1 } })
    expect(await blobState(raw)).toEqual({ state: 'purged', file: false })
    expect(await generationState(bound)).toEqual({ state: 'ready', file: true })
    expect(await blobState(raw2)).toEqual({ state: 'present', file: true })
    expect(await generationState(unbound)).toEqual({ state: 'ready', file: true })
  })
})

async function generation(input: string, master: string | null): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO rendition_generations (master_sha256, kind, recipe_digest, input_kind, input_sha256,
                                       state, ready_at, bound_at, is_active)
    VALUES (${master ? hex(master) : null}, 'preview', ${`r-${randomUUID()}`}, 'source',
            ${hex(input)}, 'ready', now(), ${master ? new Date() : null}, ${master !== null})
    RETURNING id`)
  const id = rows[0]?.id as string
  const file = store.path(`derived/gen/${id}/preview.mp4`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'preview')
  return id
}

async function generationState(id: string): Promise<{ state: string; file: boolean }> {
  const { rows } = await db.execute<{ state: string }>(sql`
    SELECT state FROM rendition_generations WHERE id = ${id}::uuid`)
  return {
    state: rows[0]?.state ?? 'none',
    file: await store.exists(`derived/gen/${id}/preview.mp4`),
  }
}

describe('a blob nobody references', () => {
  it('goes only when its original is known and reliable', async () => {
    const model = await newModel()
    const box = await source(model, 'dropbox')
    // Bytes of a revision rejected by a person: the origin and the MEGA copy checked.
    const reliable = await blob()
    const rev = await revision(model, box, reliable)
    await draft(model, box, { revision: rev }, reliable, {
      state: 'resolved',
      outcome: 'rejected',
      master: reliable,
    })
    await place(model, { revision: rev }, 'dropbox', { role: 'origin' })
    await place(model, { revision: rev }, 'mega')
    // In one cloud only.
    const single = await blob()
    const lone = await revision(model, box, single)
    await draft(model, box, { revision: lone }, single, {
      state: 'resolved',
      outcome: 'rejected',
      master: single,
    })
    await place(model, { revision: lone }, 'dropbox', { role: 'origin' })
    // Of unknown origin: the owner's command.
    const unknown = await blob()
    // An accepted master, its original reliable.
    const master = await blob()
    const accepted = await revision(model, box, master)
    await version(model, master)
    await place(model, { revision: accepted }, 'dropbox', { role: 'origin' })
    await place(model, { revision: accepted }, 'mega')

    expect(await referenced(reliable)).toBe(false)
    expect(await referenced(unknown)).toBe(false)
    expect(await free()).toMatchObject({ released: 0, removed: 1, removed_bytes: 2000 })
    expect(await blobState(reliable)).toEqual({ state: 'purged', file: false })
    for (const sha of [single, unknown, master]) {
      expect(await blobState(sha)).toEqual({ state: 'present', file: true })
    }
    expect(await free()).toMatchObject(NOTHING)
  })

  it('nothing goes while the switch is off', async () => {
    const model = await newModel()
    const web = await source(model, 'web_upload')
    const raw = await blob()
    const id = await upload(model, raw)
    await draft(model, web, { upload: id }, raw, { state: 'resolved', outcome: 'rejected' })
    await place(model, { upload: id }, 'mega')
    await place(model, { upload: id }, 'dropbox')
    await setOriginalsSwitch(db, false)
    try {
      expect(await free()).toMatchObject(NOTHING)
      expect(await blobState(raw)).toEqual({ state: 'present', file: true })
    } finally {
      await setOriginalsSwitch(db, true)
    }
    expect(await free()).toMatchObject({ released: 1, removed: 1 })
  })
})

describe('the route of the nightly compaction', () => {
  it('counts what the VM removed, for the owner and not a manager', async () => {
    const session = await signIn(server.app, OWNER.login, OWNER.password)
    const answer = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/originals/vm-freed',
      as: session,
    })
    expect(answer.statusCode).toBe(200)
    const body = OriginalsVmFreedSchema.parse(answer.json())
    expect(body).toEqual(await vmFreed(db))
    expect(body.removed_bytes).toBeGreaterThanOrEqual(body.originals_bytes)
    const manager = await addPerson(server.app, session, {
      name: 'Диана',
      login: `diana-${randomUUID().slice(0, 6)}`,
      role: 'manager',
      models: ['lora'],
    })
    const refused = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/originals/vm-freed',
      as: manager.session,
    })
    expect(refused.statusCode).toBe(403)
  })
})

describe('the staging hold', () => {
  let staging: BlobStore
  let model: string
  let box: string
  const HOUR = 3600_000

  beforeAll(async () => {
    staging = await tempStore('hold')
  })
  beforeEach(async () => {
    await rm(staging.stagingDir, { recursive: true, force: true })
    await mkdir(staging.stagingDir, { recursive: true })
    await systemTx(db, (tx) => tx.execute(sql`DELETE FROM policy_settings WHERE key = ${HOLD_KEY}`))
    model = await newModel()
    box = await source(model, 'dropbox')
  })

  /** A staged source whose master is checked, its MEGA copy still to write. */
  async function staged(
    options: { origin?: 'disk_scan' | 'legacy_import'; verifiedAt?: Date; size?: number } = {},
  ) {
    const bytes = randomBytes(options.size ?? 1_000)
    const sha = sha256(bytes)
    await writeFile(join(staging.stagingDir, `${sha}.mov`), bytes)
    const rev = await revision(model, box, sha)
    await draft(model, box, { revision: rev }, sha, {
      master: await blob(),
      origin: options.origin ?? 'disk_scan',
      ...(options.verifiedAt ? { verifiedAt: options.verifiedAt } : {}),
    })
    const origin = await place(model, { revision: rev }, 'dropbox', {
      role: 'origin',
      checked: false,
    })
    const mega = await place(model, { revision: rev }, 'mega', { checked: false })
    return { sha, rev, origin, mega, bytes: bytes.length }
  }

  const verdict = async (sha: string) =>
    (await stagingState(db, staging)).files.find((file) => file.sha === sha)?.verdict

  async function intakeBytes(): Promise<number> {
    const { rows } = await db.execute<{ bytes: string | null }>(sql`
      SELECT sum(byte_size)::text AS bytes FROM inbox_drafts
       WHERE state <> 'resolved' AND source_sha256 IS NOT NULL AND master_verified_at IS NULL`)
    return Number(rows[0]?.bytes ?? 0)
  }

  it('is held until its original is reliable, and counts in the prefetch budget', async () => {
    const file = await staged()
    expect(await verdict(file.sha)).toBe('held')
    expect(await sweepStaging(db, staging)).toEqual([])
    expect(await staging.staged(file.sha)).not.toBeNull()
    expect((await stagedAhead(db, staging)) - (await intakeBytes())).toBe(file.bytes)

    await check(file.mega)
    expect(await verdict(file.sha)).toBe('held')
    await check(file.origin)
    expect(await verdict(file.sha)).toBe('free')
    expect(await sweepStaging(db, staging)).toEqual([file.sha])
    expect(await staging.staged(file.sha)).toBeNull()
    expect((await stagedAhead(db, staging)) - (await intakeBytes())).toBe(0)
  })

  it('goes past the hours and past the bytes of the hold, the oldest first', async () => {
    const old = await staged({ verifiedAt: new Date(Date.now() - 25 * HOUR) })
    expect(await verdict(old.sha)).toBe('free')

    const earlier = await staged({ verifiedAt: new Date(Date.now() - 2 * HOUR) })
    const later = await staged({ verifiedAt: new Date(Date.now() - HOUR) })
    expect(await verdict(earlier.sha)).toBe('held')
    // 1.5 KB: the newer one stays, the older one goes.
    await systemTx(db, (tx) =>
      tx.execute(sql`
        INSERT INTO policy_settings (key, value)
        VALUES (${HOLD_KEY}, ${JSON.stringify({ hours: 24, gb: 0.0000015 })}::jsonb)`),
    )
    const state = await stagingState(db, staging)
    expect(state.heldBytes).toBe(later.bytes)
    expect(await verdict(later.sha)).toBe('held')
    expect(await verdict(earlier.sha)).toBe('free')
    expect((await sweepStaging(db, staging)).sort()).toEqual([old.sha, earlier.sha].sort())
  })

  it('is not held with the switch off, nor for the import of the old corpus', async () => {
    const legacy = await staged({ origin: 'legacy_import' })
    expect(await verdict(legacy.sha)).toBe('free')
    const file = await staged()
    await setOriginalsSwitch(db, false)
    try {
      expect(await verdict(file.sha)).toBe('free')
    } finally {
      await setOriginalsSwitch(db, true)
    }
    expect(await verdict(file.sha)).toBe('held')
  })

  it('intake keeps what it still needs, and bytes of no draft are never touched', async () => {
    const bytes = randomBytes(500)
    const sha = sha256(bytes)
    await writeFile(join(staging.stagingDir, `${sha}.mov`), bytes)
    expect(await verdict(sha)).toBe('foreign')
    const rev = await revision(model, box, sha)
    const id = await draft(model, box, { revision: rev }, sha, { state: 'processing' })
    expect(await verdict(sha)).toBe('intake')
    expect(await sweepStaging(db, staging)).toEqual([])
    expect(id).toBeTruthy()
  })
})
