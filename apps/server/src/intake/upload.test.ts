import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from '../testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from '../testing/server'
import { tusCreate, tusHead, tusPatch, tusUpload } from '../testing/tus'

/**
 * Web upload (SPEC §6.1, §9.2, schema §3.4 `web_uploads`, DESIGN §3.7): tus chunks resumed
 * from the accepted byte, the bytes registered as a blob only by the final command, one
 * draft per upload, a target accepted by itself as «принято при загрузке» by the uploader,
 * «Другое» in «Приехало», rights of the model. Bytes are generated, no people.
 */

let server: TestServer
let owner: string
let diana: { id: string; session: string }
let reader: string

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  diana = await addPerson(server.app, owner, {
    name: 'Диана',
    login: 'diana',
    role: 'manager',
    models: ['lora'],
  })
  reader = (
    await addPerson(server.app, owner, {
      name: 'Читатель',
      login: 'reader',
      role: 'reader',
      models: ['lora'],
    })
  ).session
  await createCatalogItems(server.db, 'lora', [
    { type: 'ppv', number: 89, title: 'Вдвоём на диване', files: [{ role: 'master' }] },
    { type: 'set', number: 74, title: 'Кухня утром', files: [{ role: 'raw' }, { role: 'raw' }] },
  ])
})
afterAll(() => server.close())

async function upload(row: string) {
  const { rows } = await server.db.execute<{
    state: string
    bytes_received: string
    sha: string | null
    principal_id: string
    declared_kind: string
    tmp_key: string
  }>(sql`
    SELECT state, bytes_received, encode(sha256, 'hex') AS sha, principal_id, declared_kind,
           tmp_key
      FROM web_uploads WHERE upload_id = ${row}`)
  return rows[0]
}

async function blobExists(hex: string) {
  const { rows } = await server.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM blobs WHERE sha256 = decode(${hex}, 'hex')`,
  )
  return (rows[0]?.n ?? 0) > 0
}

/** Handles of the files of a set: `ed02`, `raw01`. */
async function handles(number: number) {
  const { rows } = await server.db.execute<{ handle: string }>(sql`
    SELECT m.role || lpad(m.ordinal::text, 2, '0') AS handle FROM item_memberships m
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id
     WHERE i.type = 'SET' AND i.number = ${number} AND m.removed_at IS NULL
     ORDER BY m.role, m.ordinal`)
  return rows.map((row) => row.handle)
}

/** A sealed download of one file of an object under `name` (a receipt, schema §3.5). */
async function issued(type: string, number: number, role: string, ordinal: number, name: string) {
  await withActorTx(
    server.db,
    { actor: SYSTEM_ACTOR('test'), action: 'test.download', requestId: randomUUID() },
    async (tx) => {
      const { rows } = await tx.execute<{
        model_id: string
        item_id: string
        membership_id: string
        asset_id: string
        version_id: string
        master: Buffer
        bytes: string
      }>(sql`
        SELECT i.model_id, i.id AS item_id, m.id AS membership_id, a.id AS asset_id,
               a.current_version_id AS version_id, v.master_sha256 AS master, b.byte_size AS bytes
          FROM content_items i
          JOIN item_memberships m ON m.model_id = i.model_id AND m.item_id = i.id
          JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
          JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
          JOIN blobs b ON b.sha256 = v.master_sha256
         WHERE i.type = ${type} AND i.number = ${number} AND m.role = ${role}
           AND m.ordinal = ${ordinal}`)
      const row = rows[0]
      if (!row) throw new Error('no such file')
      const { rows: people } = await tx.execute<{ id: string }>(
        sql`SELECT id FROM principals LIMIT 1`,
      )
      const manifest = randomUUID()
      const receipt = randomUUID()
      await tx.execute(sql`
        INSERT INTO asset_manifests (model_id, id, purpose, origin_item_id, entry_count)
        VALUES (${row.model_id}::uuid, ${manifest}::uuid, 'download', ${row.item_id}::uuid, 1)`)
      await tx.execute(sql`
        INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id, membership_id,
                                            asset_id, asset_version_id, handle_snapshot)
        VALUES (${row.model_id}::uuid, ${manifest}::uuid, 1, ${row.item_id}::uuid,
                ${row.membership_id}::uuid, ${row.asset_id}::uuid, ${row.version_id}::uuid,
                ${`${role}${String(ordinal).padStart(2, '0')}`})`)
      await tx.execute(sql`
        INSERT INTO download_receipts (model_id, id, principal_id, kind, manifest_id, meta_stripped,
                                       entry_count)
        VALUES (${row.model_id}::uuid, ${receipt}::uuid, ${people[0]?.id}::uuid, 'master',
                ${manifest}::uuid, false, 1)`)
      await tx.execute(sql`
        INSERT INTO download_receipt_entries (model_id, receipt_id, position, asset_id,
                                              asset_version_id, issued_master, file_name,
                                              output_sha256, byte_size)
        VALUES (${row.model_id}::uuid, ${receipt}::uuid, 1, ${row.asset_id}::uuid,
                ${row.version_id}::uuid, true, ${name}, ${row.master}, ${Number(row.bytes)})`)
    },
  )
}

const command = (as: string, body: object, key = newKey()) =>
  call(server.app, { method: 'POST', url: '/api/v1/lora/uploads', as, key, body })

const file = (uploadId: string, name: string, bytes: Buffer, media: 'photo' | 'video') => ({
  upload_id: uploadId,
  file_name: name,
  size_bytes: bytes.length,
  media,
})

describe('tus (SPEC §6.1)', () => {
  it('continues from the accepted byte after a cut; no blob before the command', async () => {
    const bytes = randomBytes(64 * 1024)
    const created = await tusCreate(server.app, {
      model: 'lora',
      as: diana.session,
      name: 'kitchen-01.jpg',
      size: bytes.length,
      kind: 'other',
    })
    expect(created.status).toBe(201)
    expect(created.location).toBe(`/api/v1/lora/uploads/tus/${created.uploadId}`)
    expect(await upload(created.uploadId)).toMatchObject({
      state: 'receiving',
      bytes_received: '0',
      principal_id: diana.id,
      declared_kind: 'other',
      tmp_key: `inbox/web/lora/${created.uploadId}/data`,
    })

    // The first chunk arrives, then the connection is cut.
    const half = 40_000
    const first = await tusPatch(server.app, {
      location: created.location,
      as: diana.session,
      offset: 0,
      bytes: bytes.subarray(0, half),
    })
    expect(first.status).toBe(204)
    expect(await upload(created.uploadId)).toMatchObject({
      state: 'receiving',
      bytes_received: String(half),
    })
    const head = await tusHead(server.app, created.location, diana.session)
    expect(head.offset).toBe(String(half))

    // A chunk at the wrong offset is refused; the right one finishes the upload.
    const wrong = await tusPatch(server.app, {
      location: created.location,
      as: diana.session,
      offset: 0,
      bytes: bytes.subarray(half),
    })
    expect(wrong.status).toBe(409)
    const rest = await tusPatch(server.app, {
      location: created.location,
      as: diana.session,
      offset: half,
      bytes: bytes.subarray(half),
    })
    expect(rest.status).toBe(204)
    expect(await upload(created.uploadId)).toMatchObject({
      state: 'received',
      bytes_received: String(bytes.length),
      sha: null,
    })
    expect(await blobExists(sha(bytes))).toBe(false)
  })

  it('refuses the command for an upload that is not complete', async () => {
    const created = await tusCreate(server.app, {
      model: 'lora',
      as: diana.session,
      name: 'half.jpg',
      size: 1000,
    })
    await tusPatch(server.app, {
      location: created.location,
      as: diana.session,
      offset: 0,
      bytes: randomBytes(300),
    })
    const answer = await command(diana.session, {
      kind: 'other',
      target: null,
      files: [file(created.uploadId, 'half.jpg', randomBytes(1000), 'photo')],
    })
    expect(answer.statusCode).toBe(422)
    expect(answer.json()).toMatchObject({
      code: 'accept_blocked',
      details: { reason: 'upload_incomplete' },
    })
  })

  it('lets only staff of the model upload; an upload is resumed only by its author', async () => {
    const anonymous = await tusCreate(server.app, {
      model: 'lora',
      as: null,
      name: 'a.jpg',
      size: 10,
    })
    expect(anonymous.status).toBe(401)
    const read = await tusCreate(server.app, { model: 'lora', as: reader, name: 'a.jpg', size: 10 })
    expect(read.status).toBe(403)
    const otherModel = await tusCreate(server.app, {
      model: 'ari',
      as: diana.session,
      name: 'a.jpg',
      size: 10,
    })
    expect(otherModel.status).toBe(403)

    const mine = await tusCreate(server.app, {
      model: 'lora',
      as: diana.session,
      name: 'a.jpg',
      size: 10,
    })
    expect((await tusHead(server.app, mine.location, owner)).status).toBe(404)
    const commandByReader = await command(reader, {
      kind: 'other',
      target: null,
      files: [file(mine.uploadId, 'a.jpg', randomBytes(10), 'photo')],
    })
    expect(commandByReader.statusCode).toBe(403)
    const commandByOwner = await command(owner, {
      kind: 'other',
      target: null,
      files: [file(mine.uploadId, 'a.jpg', randomBytes(10), 'photo')],
    })
    expect(commandByOwner.statusCode).toBe(404)
  })
})

describe('POST /{model}/uploads', () => {
  it('«Другое»: one blob, one draft in «Приехало» «Загружено вами», a repeat answers the same', async () => {
    const bytes = randomBytes(20_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: diana.session,
      name: 'photo-from-chat.jpg',
      bytes,
    })
    const key = newKey()
    const body = {
      kind: 'other',
      target: null,
      files: [file(uploadId, 'photo-from-chat.jpg', bytes, 'photo')],
    }
    const answer = await command(diana.session, body, key)
    expect(answer.statusCode).toBe(201)
    expect(answer.json()).toMatchObject({
      placed: 'inbox',
      item_id: null,
      decision: 'what_is_it',
    })
    const again = await command(diana.session, body, key)
    expect(again.json()).toEqual(answer.json())

    expect(await upload(uploadId)).toMatchObject({ state: 'registered', sha: sha(bytes) })
    expect(await blobExists(sha(bytes))).toBe(true)
    expect(existsSync(join(server.store.roots.dataRoot, 'inbox/web/lora', uploadId))).toBe(false)
    const { rows: drafts } = await server.db.execute<{ origin: string; state: string }>(sql`
      SELECT d.origin, d.state FROM inbox_drafts d
        JOIN web_uploads u ON u.id = d.web_upload_id WHERE u.upload_id = ${uploadId}`)
    expect(drafts).toEqual([{ origin: 'web_upload', state: 'processing' }])
    const { rows: works } = await server.db.execute<{ kind: string }>(sql`
      SELECT kind FROM work_operations WHERE input_sha256 = decode(${sha(bytes)}, 'hex')`)
    expect(works.map((work) => work.kind)).toEqual(['derive_image'])

    const group = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/inbox/groups/${answer.json().group_id}`,
      as: diana.session,
    })
    expect(group.json()).toMatchObject({
      title: 'Загружено вами · 1 фото',
      root: 'Загружено вами',
      uploaded_by: { type: 'person', id: diana.id, name: 'Диана' },
      file_count: 1,
      files: [{ file_name: 'photo-from-chat.jpg', media: 'photo' }],
    })

    // The same upload in another command is refused: its draft exists already.
    const reused = await command(diana.session, body)
    expect(reused.statusCode).toBe(422)
    expect(reused.json().details).toMatchObject({ reason: 'upload_used' })
  })

  it('a teaser for an object is accepted by itself: «принято при загрузке», the uploader is the author', async () => {
    const bytes = randomBytes(30_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: diana.session,
      name: 'teaser.mp4',
      bytes,
      kind: 'teaser',
    })
    const answer = await command(diana.session, {
      kind: 'teaser',
      target: { kind: 'item', item_id: 'PPV-089' },
      files: [file(uploadId, 'teaser.mp4', bytes, 'video')],
    })
    expect(answer.statusCode).toBe(201)
    expect(answer.json()).toMatchObject({ placed: 'attached', item_id: 'PPV-089', decision: null })

    const { rows: files } = await server.db.execute<{ role: string; master: string }>(sql`
      SELECT m.role, encode(v.master_sha256, 'hex') AS master
        FROM content_items i
        JOIN item_memberships m ON m.model_id = i.model_id AND m.item_id = i.id
        JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
        JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
       WHERE i.type = 'PPV' AND i.number = 89 ORDER BY m.role`)
    expect(files).toEqual([
      { role: 'master', master: expect.any(String) },
      { role: 'teaser', master: sha(bytes) },
    ])
    const { rows: journal } = await server.db.execute<{ actor_id: string; after: object }>(sql`
      SELECT actor_id, after FROM action_log
       WHERE action = 'draft.accept_on_upload' AND entry_kind = 'action'`)
    expect(journal).toHaveLength(1)
    expect(journal[0]?.actor_id).toBe(diana.id)
    expect(journal[0]?.after).toContainEqual(['Принято', 'при загрузке'])
    const accepted = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/inbox?state=accepted',
      as: diana.session,
    })
    const group = accepted
      .json()
      .items.find((item: { id: string }) => item.id === answer.json().group_id)
    expect(group.state).toMatchObject({
      kind: 'accepted',
      item_id: 'PPV-089',
      how: 'upload',
      by: { id: diana.id, name: 'Диана' },
    })
    // Its previews are built from the new master.
    const { rows: works } = await server.db.execute<{ kind: string }>(sql`
      SELECT kind FROM work_operations WHERE input_sha256 = decode(${sha(bytes)}, 'hex')`)
    expect(works.map((work) => work.kind)).toEqual(['derive_video'])
  })

  it('a processed frame finds its source frame by the name it was downloaded under', async () => {
    // The download of `raw02` (a receipt, naming §6) named it like this.
    await issued('SET', 74, 'raw', 2, 'SET-074_kukhnya_raw02.HEIC')
    const bytes = randomBytes(5_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: owner,
      name: 'SET-074_kukhnya_raw02.jpg',
      bytes,
      kind: 'frames',
    })
    const answer = await command(owner, {
      kind: 'frames',
      target: { kind: 'item', item_id: 'SET-074' },
      files: [file(uploadId, 'SET-074_kukhnya_raw02.jpg', bytes, 'photo')],
    })
    expect(answer.json()).toMatchObject({ placed: 'attached', item_id: 'SET-074', decision: null })
    expect(await handles(74)).toEqual(['ed02', 'raw01', 'raw02'])
    const { rows } = await server.db.execute<{ parent: string }>(sql`
      SELECT pm.role || lpad(pm.ordinal::text, 2, '0') AS parent
        FROM provenance p
        JOIN asset_versions pv ON pv.model_id = p.model_id AND pv.id = p.parent_version_id
        JOIN item_memberships pm ON pm.model_id = pv.model_id AND pm.asset_id = pv.asset_id
       WHERE p.relation = 'processed_from'
         AND p.child_version_id = (SELECT v.id FROM asset_versions v
                                    WHERE v.master_sha256 = decode(${sha(bytes)}, 'hex'))`)
    expect(rows).toEqual([{ parent: 'raw02' }])
  })

  it('an unknown name asks «К какому кадру?» in «Приехало»; the answer accepts it', async () => {
    const bytes = randomBytes(6_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: owner,
      name: 'IMG_9999.jpg',
      bytes,
      kind: 'frames',
    })
    const answer = await command(owner, {
      kind: 'frames',
      target: { kind: 'item', item_id: 'SET-074' },
      files: [file(uploadId, 'IMG_9999.jpg', bytes, 'photo')],
    })
    expect(answer.json()).toMatchObject({ placed: 'inbox', item_id: null, decision: 'which_frame' })
    const group = answer.json().group_id as string
    const view = await call(server.app, {
      method: 'GET',
      url: `/api/v1/lora/inbox/groups/${group}`,
      as: owner,
    })
    expect(view.json().state).toEqual({ kind: 'decision', decision: 'which_frame' })
    const choices = view.json().frame_choices
    expect(choices.frames.map((frame: { key: string }) => frame.key)).toEqual(['raw01', 'raw02'])
    const decided = await call(server.app, {
      method: 'POST',
      url: `/api/v1/lora/inbox/groups/${group}:decide`,
      as: owner,
      key: newKey(),
      body: { decision: 'which_frame', file_key: choices.file_key, frame: 'raw01' },
    })
    expect(decided.statusCode).toBe(200)
    expect(decided.json().state).toMatchObject({
      kind: 'accepted',
      item_id: 'SET-074',
      how: 'upload',
    })
    expect(await handles(74)).toEqual(['ed01', 'ed02', 'raw01', 'raw02'])
  })

  it('refuses what does not fit the target before touching the bytes; a plan row waits for 4а', async () => {
    const bytes = randomBytes(1_000)
    const uploadId = await tusUpload(server.app, {
      model: 'lora',
      as: owner,
      name: 'still.jpg',
      bytes,
      kind: 'teaser',
    })
    const wrong = await command(owner, {
      kind: 'teaser',
      target: { kind: 'item', item_id: 'PPV-089' },
      files: [file(uploadId, 'still.jpg', bytes, 'photo')],
    })
    expect(wrong.statusCode).toBe(422)
    expect(wrong.json().message).toBe('Тизер — один видеофайл')
    expect(await upload(uploadId)).toMatchObject({ state: 'received', sha: null })

    const row = await command(owner, {
      kind: 'fyp_montage',
      target: { kind: 'plan_row', row_id: 'row-1' },
      files: [file(uploadId, 'still.jpg', bytes, 'photo')],
    })
    expect(row.statusCode).toBe(501)
  })
})
