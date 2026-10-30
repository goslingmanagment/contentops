import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WorkRunner } from '@contentops/db'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMediaEnv, type MediaEnv } from './media/pipeline'
import { shaBytes } from './media/storage'
import { registerBlob } from './media/storage-ops'
import { systemTx, tempFile } from './media/testing'
import { exportHandler } from './media/work/export'
import { createCatalogItems } from './testing/catalog-factory'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from './testing/server'

/**
 * Promo (PLAN 4в, SPEC §5, §7.1, §9.3): collections of links without copying bytes, one file
 * once per collection, the live collection follows the current version while a prepared and
 * a sent handoff stay pinned; the ZIP and `manifest.csv` match the sealed composition;
 * «Передано» once; a follow-up is a new handoff; the history keeps the masters; rights.
 * The mock's promo rules (`packages/mock-api`) live here now.
 */

let server: TestServer
let owner: string
let manager: string
let reader: string
let env: MediaEnv
const masters = new Map<string, string>()

const FAKE_VERSIONS = {
  ffmpeg: 'n8.1.2-test',
  ffprobe: 'n8.1.2-test',
  svtav1: 'v4.2.0-test',
  libvips: '8.16.1',
  sharp: '0.34.2',
  libheif: null,
  libde265: null,
  libwebp: null,
  phash: 'sharp-phash@2.2.0',
}

async function put(name: string, bytes: Buffer, ext: string, kind: 'video' | 'image') {
  const file = await tempFile(bytes, `${name}.${ext}`)
  await registerBlob(server.db, server.store, {
    file: file.path,
    sha256: file.sha256,
    ext,
    mediaKind: kind,
    owner: 'worker:test:1',
  })
  masters.set(name, file.sha256)
  return shaBytes(file.sha256)
}

const lora = '/api/v1/lora'

async function post(as: string, url: string, body?: unknown, extra: { ifMatch?: number } = {}) {
  return call(server.app, {
    method: 'POST',
    url: `${lora}${url}`,
    as,
    key: newKey(),
    body,
    ...extra,
  })
}

async function get(as: string, url: string) {
  return call(server.app, { method: 'GET', url: `${lora}${url}`, as })
}

/** The export work of the handoffs builds their ZIPs, as the `worker` role does. */
async function build(handoff: string, collection: string) {
  const runner = new WorkRunner({
    db: server.db,
    role: 'worker',
    handlers: { export: exportHandler(env) },
    pollMs: 20,
  })
  runner.start()
  try {
    return await vi.waitFor(
      async () => {
        const view = (await get(owner, `/promo/collections/${collection}`)).json()
        const found = view.handoffs.find((h: { id: string }) => h.id === handoff)
        if (found?.state !== 'prepared') throw new Error(found?.state ?? 'missing')
        return found
      },
      { timeout: 15_000, interval: 50 },
    )
  } finally {
    await runner.stop()
  }
}

/** Names and bytes of a stored ZIP (the writer never compresses). */
function readZip(zip: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = []
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18)
    const nameLength = zip.readUInt16LE(at + 26)
    const extraLength = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const start = at + 30 + nameLength + extraLength
    entries.push({ name, data: zip.subarray(start, start + size) })
    at = start + size
  }
  return entries
}

async function zipOf(url: string): Promise<Buffer> {
  const response = await call(server.app, { method: 'GET', url, as: owner })
  expect(response.statusCode).toBe(200)
  const accel = String(response.headers['x-accel-redirect'])
  expect(accel).toMatch(/^\/_accel\/tmp\/exports\//)
  return readFile(server.store.path(accel.replace('/_accel/tmp/', '')))
}

async function counts() {
  const { rows } = await server.db.execute<{ assets: number; versions: number; blobs: number }>(
    sql`SELECT (SELECT count(*)::int FROM assets) AS assets,
               (SELECT count(*)::int FROM asset_versions) AS versions,
               (SELECT count(*)::int FROM blobs) AS blobs`,
  )
  return rows[0]
}

let garanteam: { id: string; version: number }
let coraline: { id: string; version: number }

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  manager = (
    await addPerson(server.app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora'],
    })
  ).session
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora'],
    })
  ).session
  env = await createMediaEnv({
    db: server.db,
    store: server.store,
    lp: 4,
    owner: 'worker:test',
    log: () => {},
    versions: FAKE_VERSIONS,
    activate: false,
  })
  const photo = await sharp({
    create: { width: 30, height: 40, channels: 3, background: '#a0a0a0' },
  })
    .jpeg()
    .withExif({ IFD0: { Make: 'FixtureCam', Model: 'Pattern 2' } })
    .toBuffer()
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'raw',
      number: 213,
      title: 'Съёмка офис',
      files: [
        {
          role: 'raw',
          media: 'video',
          sha256: [await put('raw01', Buffer.from('clip one'), 'mp4', 'video')],
          durationS: 15,
        },
        {
          role: 'raw',
          media: 'video',
          sha256: [await put('raw02', Buffer.from('clip two!'), 'mp4', 'video')],
          durationS: 20,
        },
        {
          role: 'raw',
          media: 'video',
          sha256: [await put('raw03', Buffer.from('clip three'), 'mp4', 'video')],
          durationS: 9,
        },
      ],
    },
    {
      type: 'set',
      number: 69,
      title: 'Шумы, полосы',
      files: [{ role: 'ed', sha256: [await put('ed01', photo, 'jpg', 'image')] }],
    },
    {
      type: 'ppv',
      number: 73,
      title: 'День рождения',
      files: [
        {
          role: 'master',
          versions: 2,
          sha256: [
            await put('ppv-v1', Buffer.from('master version one'), 'mp4', 'video'),
            await put('ppv-v2', Buffer.from('master version two, longer'), 'mp4', 'video'),
          ],
        },
      ],
    },
  ])
  const added = async (body: unknown) => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/lora/contractors',
      as: owner,
      key: newKey(),
      body,
    })
    expect(response.statusCode, response.body).toBe(201)
    return response.json()
  }
  garanteam = await added({
    name: 'GaranTTeam Social',
    channel: 'reddit',
    contact: '@garanteam',
    format: 'master',
  })
  coraline = await added({ name: 'Coraline Red', channel: null, contact: null, format: 'upload' })
})
afterAll(() => server.close())

const RAW = (n: number) => ({ item_id: 'RAW-0213', file_key: `raw0${n}` })

describe('contractors (SPEC §7.1, DESIGN §4.19)', () => {
  it('are listed for the model with their one format field', async () => {
    const list = (await get(manager, '/promo/contractors')).json()
    expect(list.items).toEqual([
      {
        id: garanteam.id,
        name: 'GaranTTeam Social',
        channel: 'reddit',
        contact: '@garanteam',
        format: 'master',
        version: 1,
      },
      expect.objectContaining({ name: 'Coraline Red', channel: null, format: 'upload' }),
    ])
  })

  it('only the owner adds or changes one; the change needs If-Match', async () => {
    const url = `/api/v1/admin/models/lora/contractors/${coraline.id}`
    const asManager = await call(server.app, {
      method: 'PATCH',
      url,
      as: manager,
      key: newKey(),
      ifMatch: 1,
      body: { format: 'compat' },
    })
    expect(asManager.statusCode).toBe(403)
    const bare = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      body: { format: 'compat' },
    })
    expect(bare.statusCode).toBe(428)
    const changed = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: { format: 'compat' },
    })
    expect(changed.json()).toMatchObject({ format: 'compat', version: 2 })
    const stale = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: { format: 'upload' },
    })
    expect(stale.statusCode).toBe(412)
    const back = await call(server.app, {
      method: 'PATCH',
      url,
      as: owner,
      key: newKey(),
      ifMatch: 2,
      body: { format: 'upload' },
    })
    coraline = back.json()
    const twice = await call(server.app, {
      method: 'POST',
      url: '/api/v1/admin/models/lora/contractors',
      as: owner,
      key: newKey(),
      body: { name: 'Coraline Red', channel: null, contact: null, format: 'master' },
    })
    expect(twice.statusCode).toBe(400)
  })
})

describe('collections are a view of the catalog (SPEC §7.1)', () => {
  it('a new collection links files of other objects without copying bytes', async () => {
    const before = await counts()
    const response = await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'new',
      title: 'Офис, нейлон',
      members: [RAW(1), RAW(2), { item_id: 'SET-069', file_key: 'ed01' }],
    })
    expect(response.statusCode, response.body).toBe(200)
    const collection = response.json()
    expect(collection).toMatchObject({
      id: 'PRM-001',
      title: 'Офис, нейлон',
      channel: 'reddit',
      video_count: 2,
      photo_count: 1,
    })
    expect(
      collection.members.map(
        (m: { item_id: string; file_key: string }) => `${m.item_id}/${m.file_key}`,
      ),
    ).toEqual(['RAW-0213/raw01', 'RAW-0213/raw02', 'SET-069/ed01'])
    const video = collection.members[0]
    const photo = collection.members[2]
    expect(video.duration_s).toBe(15)
    expect(photo.duration_s).toBeNull()
    expect(await counts()).toEqual(before)
    // The source object keeps its file; nothing moved.
    const raw = (await get(manager, '/i/RAW-0213')).json()
    expect(raw.files.map((f: { key: string }) => f.key)).toEqual(['raw01', 'raw02', 'raw03'])
  })

  it('a repeat adds nothing; another collection takes the same file and both show it', async () => {
    const again = await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'PRM-001',
      title: null,
      members: [RAW(1), RAW(2)],
    })
    expect(again.json().members).toHaveLength(3)
    const second = await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'new',
      title: 'Второй пак',
      members: [RAW(1)],
    })
    expect(second.json().id).toBe('PRM-002')
    const first = (await get(manager, '/promo/collections/PRM-001')).json()
    expect(first.members[0].other_collections).toEqual(['PRM-002'])
  })

  it('a collection of another channel is refused; an unknown file is 404', async () => {
    const response = await post(manager, '/promo/collections:add', {
      channel: 'instagram',
      collection: 'PRM-001',
      title: null,
      members: [RAW(3)],
    })
    expect(response.statusCode).toBe(404)
    const unknown = await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'PRM-001',
      title: null,
      members: [{ item_id: 'RAW-0213', file_key: 'raw09' }],
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('remove closes the link and «Вернуть» brings it back; the order follows the PRM', async () => {
    const removed = await post(manager, '/promo/collections/PRM-002:remove', { members: [RAW(1)] })
    expect(removed.json().members).toEqual([])
    const back = await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'PRM-002',
      title: null,
      members: [RAW(1), RAW(3)],
    })
    expect(back.json().members.map((m: { file_key: string }) => m.file_key)).toEqual([
      'raw01',
      'raw03',
    ])
    const page = (await get(manager, '/i/PRM-002')).json()
    const keys = page.files.map((f: { key: string }) => f.key)
    const reordered = await call(server.app, {
      method: 'POST',
      url: `${lora}/i/PRM-002/files:reorder`,
      as: manager,
      key: newKey(),
      ifMatch: page.version,
      body: { keys: [...keys].reverse() },
    })
    expect(reordered.statusCode, reordered.body).toBe(200)
    const after = (await get(manager, '/promo/collections/PRM-002')).json()
    expect(after.members.map((m: { file_key: string }) => m.file_key)).toEqual(['raw03', 'raw01'])
  })

  it('the channel shows its collections and every material once', async () => {
    const channel = (await get(reader, '/promo/channels/reddit')).json()
    expect(channel.collections.map((c: { id: string }) => c.id)).toEqual(['PRM-002', 'PRM-001'])
    expect(channel.materials).toHaveLength(4)
    const channels = (await get(reader, '/promo/channels')).json().items
    expect(channels).toEqual([
      expect.objectContaining({
        id: 'reddit',
        name: 'Reddit',
        orientation: 'vertical',
        collection_count: 2,
        file_count: 4,
        last_handoff_on: null,
      }),
    ])
    expect(channels[0].covers).toHaveLength(4)
  })
})

describe('handoffs (SPEC §5, §7.1, §9.3)', () => {
  let first: { id: string; zip_url: string }

  it('prepare pins the versions and the format, 202 with an operation, then prepared', async () => {
    const started = await post(manager, '/promo/collections/PRM-001/handoffs', {
      contractor_id: garanteam.id,
      strip_metadata: false,
      exclude_already_handed: true,
      members: null,
    })
    expect(started.statusCode, started.body).toBe(202)
    const answer = started.json()
    expect(answer).toMatchObject({ kind: 'operation', handoff_id: expect.any(String) })
    const operation = (
      await call(server.app, { method: 'GET', url: answer.status_url, as: manager })
    ).json()
    expect(operation).toMatchObject({ kind: 'handoff', state: 'running' })
    const preparing = (await get(manager, '/promo/collections/PRM-001')).json()
    expect(preparing.handoffs.at(-1)).toMatchObject({
      state: 'preparing',
      format: 'master',
      zip_url: null,
      member_keys: ['RAW-0213/raw01', 'RAW-0213/raw02', 'SET-069/ed01'],
    })
    expect(preparing.handoffs.at(-1).size_bytes, 'estimated while building').toBeGreaterThan(0)
    expect(preparing.contractor_id).toBe(garanteam.id)

    const prepared = await build(answer.handoff_id, 'PRM-001')
    first = prepared
    expect(prepared).toMatchObject({
      contractor_name: 'GaranTTeam Social',
      format: 'master',
      video_count: 2,
      photo_count: 1,
      strip_metadata: false,
      zip_name: 'PRM-001_garantteam-social.zip',
      zip_files: [
        'PRM-001_01_RAW-0213-raw01.mp4',
        'PRM-001_02_RAW-0213-raw02.mp4',
        'PRM-001_03_SET-069-ed01.jpg',
        'manifest.csv',
      ],
      status: { word: 'подготовлено' },
    })
    expect(prepared.summary_text).toMatch(/^Офис, нейлон · 2 видео · 1 фото · \d+ КБ$/)
  })

  it('the ZIP and manifest.csv match the sealed composition and receipt', async () => {
    const zip = readZip(await zipOf(first.zip_url))
    expect(zip.map((entry) => entry.name)).toEqual([
      'PRM-001_01_RAW-0213-raw01.mp4',
      'PRM-001_02_RAW-0213-raw02.mp4',
      'PRM-001_03_SET-069-ed01.jpg',
      'manifest.csv',
    ])
    const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    expect(sha(zip[0]?.data as Buffer)).toBe(masters.get('raw01'))
    expect(sha(zip[2]?.data as Buffer)).toBe(masters.get('ed01'))
    const csv = String(zip[3]?.data).trim().split('\n')
    expect(csv).toEqual([
      'prm,order,file_name,source_id,role,version,master_sha256,format,size_bytes',
      `PRM-001,1,PRM-001_01_RAW-0213-raw01.mp4,RAW-0213,raw01,1,${masters.get('raw01')},master,8`,
      `PRM-001,2,PRM-001_02_RAW-0213-raw02.mp4,RAW-0213,raw02,1,${masters.get('raw02')},master,9`,
      `PRM-001,3,PRM-001_03_SET-069-ed01.jpg,SET-069,ed01,1,${masters.get('ed01')},master,${zip[2]?.data.length}`,
    ])
    const { rows } = await server.db.execute<{ names: string[]; kind: string; same: boolean }>(sql`
      SELECT array_agg(e.file_name ORDER BY e.position) AS names, r.kind,
             r.manifest_id = d.manifest_id AS same
        FROM promo_deliveries d
        JOIN download_receipts r ON r.id = d.receipt_id
        JOIN download_receipt_entries e ON e.receipt_id = r.id
       WHERE d.id = ${first.id}::uuid
       GROUP BY r.kind, r.manifest_id, d.manifest_id`)
    expect(rows[0]).toEqual({
      names: zip.slice(0, 3).map((entry) => entry.name),
      kind: 'promo',
      same: true,
    })
  })

  it('«только чтение» sees handoffs but does not download or prepare', async () => {
    expect(
      (await call(server.app, { method: 'GET', url: first.zip_url, as: reader })).statusCode,
    ).toBe(403)
    const attempt = await post(reader, '/promo/collections/PRM-001/handoffs', {
      contractor_id: garanteam.id,
      strip_metadata: true,
      exclude_already_handed: true,
      members: null,
    })
    expect(attempt.statusCode).toBe(403)
    expect((await get(reader, '/promo/handoffs')).statusCode).toBe(200)
  })

  it('«Передано» is once: a repeat changes nothing and logs nothing', async () => {
    const url = `/promo/collections/PRM-001/handoffs/${first.id}:mark-sent`
    const sent = await post(manager, url)
    expect(sent.statusCode, sent.body).toBe(200)
    expect(sent.json()).toMatchObject({ state: 'sent', status: { sign: 'done', word: 'передано' } })
    const again = await post(owner, url)
    expect(again.json()).toEqual(sent.json())
    const { rows } = await server.db.execute<{ marks: number; placements: number }>(sql`
      SELECT (SELECT count(*)::int FROM action_log
               WHERE action = 'promo.markSent' AND entry_kind = 'action' AND result = 'ok') AS marks,
             (SELECT count(*)::int FROM placements) AS placements`)
    expect(rows[0]).toEqual({ marks: 1, placements: 0 })
  })

  it('«уже передавали»: the same contractor sees the overlap, another does not', async () => {
    const check = (contractor: string) =>
      get(manager, `/promo/collections/PRM-001/handoff-check?contractor=${contractor}`)
    const same = (await check(garanteam.id)).json()
    expect(same.already).toBe(3)
    expect(same.text).toMatch(/^3 из 3 уже передавали GaranTTeam Social \(PRM-001, \d\d\.\d\d\)$/)
    const other = (await check(coraline.id)).json()
    expect(other).toMatchObject({ already: 0, text: null })
    const collection = (await get(manager, '/promo/collections/PRM-001')).json()
    expect(collection.members[0].handed_to).toEqual([
      {
        contractor_id: garanteam.id,
        contractor: 'GaranTTeam Social',
        collection_id: 'PRM-001',
        on: expect.any(String),
      },
    ])
    // The same file in another collection carries the history too.
    const second = (await get(manager, '/promo/collections/PRM-002')).json()
    const raw01 = second.members.find((m: { file_key: string }) => m.file_key === 'raw01')
    expect(raw01.handed_to).toHaveLength(1)
  })

  it('«Убрать их» with nothing new is refused; a follow-up carries only what was added', async () => {
    const prepare = (members: unknown) =>
      post(manager, '/promo/collections/PRM-001/handoffs', {
        contractor_id: garanteam.id,
        strip_metadata: false,
        exclude_already_handed: true,
        members,
      })
    const nothing = await prepare(null)
    expect(nothing.statusCode).toBe(400)
    await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'PRM-001',
      title: null,
      members: [{ item_id: 'PPV-073', file_key: 'master' }],
    })
    const overlap = (
      await get(manager, `/promo/collections/PRM-001/handoff-check?contractor=${garanteam.id}`)
    ).json()
    expect(overlap.text).toMatch(/^3 из 4 уже передавали/)
    const started = await prepare(null)
    expect(started.statusCode).toBe(202)
    const followUp = await build(started.json().handoff_id, 'PRM-001')
    expect(followUp).toMatchObject({
      video_count: 1,
      photo_count: 0,
      member_keys: ['PPV-073/master'],
      zip_files: ['PRM-001_01_PPV-073.mp4', 'manifest.csv'],
    })
    const all = (await get(manager, '/promo/collections/PRM-001')).json()
    expect(all.handoffs.map((h: { state: string }) => h.state)).toEqual(['sent', 'prepared'])
  })

  it('a live collection follows a new version; prepared and sent handoffs stay pinned', async () => {
    const before = (await get(manager, '/promo/collections/PRM-001')).json()
    const pending = before.handoffs.at(-1)
    const newer = await put(
      'ppv-v3',
      Buffer.from('master version three, the longest one'),
      'mp4',
      'video',
    )
    await systemTx(server.db, async (tx) => {
      const { rows } = await tx.execute<{ asset_id: string; model_id: string }>(sql`
        SELECT a.id AS asset_id, a.model_id FROM assets a
          JOIN content_items i ON i.model_id = a.model_id AND i.id = a.created_in_item_id
         WHERE i.type = 'PPV' AND i.number = 73`)
      const asset = rows[0]
      await tx.execute(sql`
        WITH v AS (
          INSERT INTO asset_versions (model_id, asset_id, version_no, master_sha256)
          VALUES (${asset?.model_id}::uuid, ${asset?.asset_id}::uuid, 3, ${newer})
          RETURNING id)
        UPDATE assets SET current_version_id = (SELECT id FROM v)
         WHERE id = ${asset?.asset_id}::uuid`)
    })
    const live = (await get(manager, '/promo/collections/PRM-001')).json()
    const ppv = live.members.find((m: { item_id: string }) => m.item_id === 'PPV-073')
    expect(ppv.size_bytes).toBe('master version three, the longest one'.length)
    // The prepared follow-up still issues v2: its ZIP and its list did not move.
    const zip = readZip(await zipOf(pending.zip_url))
    expect(
      createHash('sha256')
        .update(zip[0]?.data as Buffer)
        .digest('hex'),
    ).toBe(masters.get('ppv-v2'))
    expect(String(zip[1]?.data)).toContain(`,2,${masters.get('ppv-v2')},`)
    const { rows } = await server.db.execute<{ version_no: number }>(sql`
      SELECT v.version_no FROM promo_deliveries d
        JOIN asset_manifest_entries e ON e.manifest_id = d.manifest_id
        JOIN asset_versions v ON v.id = e.asset_version_id
       WHERE d.id = ${pending.id}::uuid`)
    expect(rows).toEqual([{ version_no: 2 }])
  })

  it('preparing again replaces the unsent one; the replaced one cannot be marked', async () => {
    const before = (await get(manager, '/promo/collections/PRM-001')).json()
    const pending = before.handoffs.at(-1)
    const again = await post(manager, '/promo/collections/PRM-001/handoffs', {
      contractor_id: garanteam.id,
      strip_metadata: false,
      exclude_already_handed: true,
      members: null,
    })
    expect(again.statusCode).toBe(202)
    const redo = await build(again.json().handoff_id, 'PRM-001')
    expect(redo.member_keys).toEqual(['PPV-073/master'])
    expect(redo.zip_files[0]).toBe('PRM-001_01_PPV-073.mp4')
    const after = (await get(manager, '/promo/collections/PRM-001')).json()
    expect(after.handoffs.map((h: { id: string }) => h.id)).toEqual([first.id, redo.id])
    const stale = await post(manager, `/promo/collections/PRM-001/handoffs/${pending.id}:mark-sent`)
    expect(stale.statusCode).toBe(422)
    expect(stale.json().code).toBe('handoff_replaced')
  })

  it('«для заливки» needs the media pipeline for a video: 503 until it runs', async () => {
    const response = await post(manager, '/promo/collections/PRM-002/handoffs', {
      contractor_id: coraline.id,
      strip_metadata: true,
      exclude_already_handed: true,
      members: [RAW(3)],
    })
    expect(response.statusCode).toBe(503)
  })

  it('a selection inside the collection goes alone; a new handoff after «Передано» is new', async () => {
    const ed01 = { item_id: 'SET-069', file_key: 'ed01' }
    await post(manager, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'PRM-002',
      title: null,
      members: [ed01],
    })
    const started = await post(manager, '/promo/collections/PRM-002/handoffs', {
      contractor_id: coraline.id,
      strip_metadata: true,
      exclude_already_handed: true,
      members: [ed01],
    })
    expect(started.statusCode, started.body).toBe(202)
    const handoff = await build(started.json().handoff_id, 'PRM-002')
    expect(handoff).toMatchObject({
      format: 'upload',
      strip_metadata: true,
      member_keys: ['SET-069/ed01'],
      zip_files: ['PRM-002_01_SET-069-ed01.jpg', 'manifest.csv'],
    })
    // «Стереть метаданные»: the issued frame is a new file without the camera tags.
    const [frame] = readZip(await zipOf(handoff.zip_url))
    expect(
      createHash('sha256')
        .update(frame?.data as Buffer)
        .digest('hex'),
    ).not.toBe(masters.get('ed01'))
    expect((await sharp(frame?.data).metadata()).exif).toBeUndefined()
    const sent = await post(manager, `/promo/collections/PRM-002/handoffs/${handoff.id}:mark-sent`)
    expect(sent.json().state).toBe('sent')
    const resend = await post(manager, '/promo/collections/PRM-002/handoffs', {
      contractor_id: coraline.id,
      strip_metadata: false,
      exclude_already_handed: false,
      members: [ed01],
    })
    expect(resend.statusCode).toBe(202)
    const list = (await get(manager, '/promo/collections/PRM-002')).json().handoffs
    expect(list.map((h: { state: string }) => h.state)).toEqual(['sent', 'preparing'])
    expect(list[0].id).toBe(handoff.id)
    await build(resend.json().handoff_id, 'PRM-002')
  })

  it('the history keeps the masters referenced after the collection and the asset move on', async () => {
    await post(manager, '/promo/collections/PRM-001:remove', {
      members: [{ item_id: 'PPV-073', file_key: 'master' }],
    })
    const { rows } = await server.db.execute<{ held: boolean }>(sql`
      SELECT blob_is_referenced(${shaBytes(masters.get('ppv-v2') as string)}) AS held`)
    expect(rows[0]?.held).toBe(true)
    const page = (await get(manager, '/i/PRM-001')).json()
    expect(page.handoffs.map((h: { status: { word: string } }) => h.status.word)).toEqual([
      'передано',
      'подготовлено',
    ])
  })

  it('the journal names the promo steps; the list of handoffs is newest first', async () => {
    const handoffs = (await get(owner, '/promo/handoffs')).json().items
    expect(handoffs[0].collection_id).toBe('PRM-002')
    const journal = (
      await call(server.app, { method: 'GET', url: `${lora}/journal?area=promo`, as: owner })
    ).json()
    const phrases = journal.items.map((event: { phrase: string }) => event.phrase).join('\n')
    expect(phrases).toMatch(/Диана отметил\S* передачу PRM-001/)
    expect(phrases).toMatch(/Диана начал\S* готовить передачу PRM-001/)
    expect(phrases).toMatch(/Диана завел\S* подборку PRM-001|Диана завёл\S* подборку PRM-001/)
  })
})

describe('rights and models (SPEC §11.1, §11.2)', () => {
  it('another model is 403; an unknown collection or channel is 404 inside the model', async () => {
    const foreign = await addPerson(server.app, owner, {
      name: 'Аня',
      login: 'anya-promo',
      role: 'manager',
      models: ['ari'],
    })
    expect((await get(foreign.session, '/promo/channels')).statusCode).toBe(403)
    expect((await get(foreign.session, '/promo/collections/PRM-001')).statusCode).toBe(403)
    expect((await get(owner, '/promo/collections/PRM-404')).statusCode).toBe(404)
    expect((await get(owner, '/promo/collections/RAW-0213')).statusCode).toBe(404)
    expect((await get(owner, '/promo/channels/tiktok')).statusCode).toBe(404)
    const add = await post(reader, '/promo/collections:add', {
      channel: 'reddit',
      collection: 'new',
      title: null,
      members: [RAW(1)],
    })
    expect(add.statusCode).toBe(403)
    const contractors = await call(server.app, {
      method: 'GET',
      url: '/api/v1/ari/promo/contractors',
      as: owner,
    })
    expect(contractors.json().items, 'contractors live in their model').toEqual([])
  })
})
