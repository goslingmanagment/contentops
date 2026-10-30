import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { WorkRunner } from '@contentops/db'
import { sql } from 'drizzle-orm'
import exifr from 'exifr'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { createMediaEnv } from './pipeline'
import { createGeneration, finishGenerations } from './renditions'
import { blobKey, shaBytes } from './storage'
import { registerBlob } from './storage-ops'
import { systemTx, tempFile } from './testing'
import { exportHandler } from './work/export'

/**
 * The download path (PLAN 2а «Скачивание из карточки», 2б «выдача с очисткой метаданных»,
 * SPEC §11.2): two steps, the sealed receipt with the issued hash and name, `X-Accel-Redirect`
 * with `Content-Disposition`, previews by generation scoped to the model.
 */

let server: TestServer
let owner: string
let reader: string
let master: string
let photo: string
let generation: string

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

async function put(bytes: Buffer, ext: string, kind: 'video' | 'image'): Promise<string> {
  const file = await tempFile(bytes, `file.${ext}`)
  await registerBlob(server.db, server.store, {
    file: file.path,
    sha256: file.sha256,
    ext,
    mediaKind: kind,
    owner: 'worker:test:1',
  })
  return file.sha256
}

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora'],
    })
  ).session
  master = await put(Buffer.from('a master video of PPV-073'), 'mp4', 'video')
  const jpeg = await sharp({
    create: { width: 64, height: 32, channels: 3, background: '#808080' },
  })
    .jpeg()
    .withExif({ IFD0: { Make: 'FixtureCam', Model: 'Pattern 1' } })
    .withMetadata({ orientation: 6 })
    .toBuffer()
  photo = await put(jpeg, 'jpg', 'image')
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'ppv',
      number: 73,
      title: 'День рождения, торт',
      titleEn: 'birthday cake lace',
      files: [
        { role: 'master', durationS: 804, sha256: [shaBytes(master)], width: 1080, height: 1920 },
        { role: 'pic', sha256: [shaBytes(photo)], width: 32, height: 64 },
      ],
    },
  ])
  generation = await createGeneration(server.db, {
    kind: 'thumb640',
    recipeDigest: 'test-thumb',
    metaStripped: false,
    masterSha256: shaBytes(master),
    inputKind: 'master',
    inputSha256: shaBytes(master),
    workId: null,
  })
  const thumb = await tempFile('thumb bytes', 'thumb-640.webp')
  const key = `derived/gen/${generation}/thumb-640.webp`
  await server.store.place(thumb.path, key)
  await systemTx(server.db, (tx) =>
    finishGenerations(
      tx,
      [
        {
          generationId: generation,
          key,
          artifact: {
            kind: 'thumb640',
            name: 'thumb-640.webp',
            path: thumb.path,
            sha256: thumb.sha256,
            bytes: 11,
            mime: 'image/webp',
            width: 360,
            height: 640,
            durationMs: null,
            frameMs: null,
          },
        },
      ],
      [generation],
    ),
  )
})
afterAll(() => server.close())

async function receiptOf(id: string) {
  const { rows } = await server.db.execute<{
    kind: string
    meta_stripped: boolean
    entry_count: number
    file_name: string
    output_sha256: Buffer
    issued_master: boolean
    export_key: string | null
    manifest_entries: number
  }>(sql`
    SELECT r.kind, r.meta_stripped, r.entry_count, e.file_name, e.output_sha256, e.issued_master,
           e.export_key,
           (SELECT count(*)::int FROM asset_manifest_entries m WHERE m.manifest_id = r.manifest_id)
             AS manifest_entries
      FROM download_receipts r JOIN download_receipt_entries e ON e.receipt_id = r.id
     WHERE r.id = ${id}::uuid`)
  return rows
}

describe('download — ready at once', () => {
  it('issues the master as is with a sealed receipt; GET gives X-Accel-Redirect and the name', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-073/downloads',
      as: owner,
      key: newKey(),
      body: { kind: 'master', strip_metadata: false, account: null },
    })
    expect(response.statusCode).toBe(200)
    const answer = response.json()
    expect(answer).toMatchObject({
      kind: 'ready',
      file_name: 'PPV-073_birthday-cake-lace_master__13m24s.mp4',
      size_bytes: 25,
    })
    const receipt = answer.download_url.split('/').pop()
    expect(await receiptOf(receipt)).toEqual([
      {
        kind: 'master',
        meta_stripped: false,
        entry_count: 1,
        file_name: 'PPV-073_birthday-cake-lace_master__13m24s.mp4',
        output_sha256: shaBytes(master),
        issued_master: true,
        export_key: null,
        manifest_entries: 1,
      },
    ])

    const file = await call(server.app, { method: 'GET', url: answer.download_url, as: owner })
    expect(file.statusCode).toBe(200)
    expect(file.headers['x-accel-redirect']).toBe(`/_accel/${blobKey(master, 'mp4')}`)
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="PPV-073_birthday-cake-lace_master__13m24s.mp4"; filename*=UTF-8''PPV-073_birthday-cake-lace_master__13m24s.mp4`,
    )
    expect(file.body).toBe('')

    expect(
      (await call(server.app, { method: 'GET', url: answer.download_url, as: reader })).statusCode,
    ).toBe(403)
  })

  it('names the page and today for «Залить сейчас»', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-073/downloads',
      as: owner,
      key: newKey(),
      body: { kind: 'master', strip_metadata: false, account: 'lora-1' },
    })
    expect(response.json().file_name).toMatch(
      /^PPV-073_birthday-cake-lace_master__lora-1_\d{4}-\d{2}-\d{2}__13m24s\.mp4$/,
    )
  })

  it('«только чтение» does not download', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-073/downloads',
      as: reader,
      key: newKey(),
      body: { kind: 'master', strip_metadata: false, account: null },
    })
    expect(response.statusCode).toBe(403)
  })
})

describe('download — two steps with metadata stripped', () => {
  it('202 with an operation, the export work strips EXIF but keeps the orientation, then ready', async () => {
    const response = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-073/files:download',
      as: owner,
      key: newKey(),
      body: { keys: ['pic01'], strip_metadata: true },
    })
    expect(response.statusCode).toBe(200)
    const started = response.json()
    expect(started).toMatchObject({ kind: 'operation' })
    const status = () => call(server.app, { method: 'GET', url: started.status_url, as: owner })
    expect((await status()).json()).toMatchObject({ state: 'running', kind: 'source_zip' })

    const env = await createMediaEnv({
      db: server.db,
      store: server.store,
      lp: 4,
      owner: 'worker:test',
      log: () => {},
      versions: FAKE_VERSIONS,
      activate: false,
    })
    const runner = new WorkRunner({
      db: server.db,
      role: 'worker',
      handlers: { export: exportHandler(env) },
      pollMs: 20,
    })
    runner.start()
    const done = await vi.waitFor(
      async () => {
        const answer = (await status()).json()
        if (answer.state !== 'done') throw new Error(answer.state)
        return answer
      },
      { timeout: 10_000, interval: 50 },
    )
    await runner.stop()
    expect(done.result).toMatchObject({ file_name: 'PPV-073_birthday-cake-lace_pic01.jpg' })

    const receipt = done.result.download_url.split('/').pop()
    const [entry] = await receiptOf(receipt)
    expect(entry).toMatchObject({ meta_stripped: true, issued_master: false, kind: 'master' })
    const file = await call(server.app, { method: 'GET', url: done.result.download_url, as: owner })
    expect(file.statusCode).toBe(200)
    const accel = String(file.headers['x-accel-redirect'])
    expect(accel).toBe(`/_accel/tmp/${entry?.export_key}`)
    const bytes = await readFile(server.store.path(entry?.export_key as string))
    expect(createHash('sha256').update(bytes).digest()).toEqual(entry?.output_sha256)
    const exif = await exifr.parse(bytes, { tiff: true, ifd0: {}, gps: true })
    expect(exif?.Make).toBeUndefined()
    expect(exif?.latitude).toBeUndefined()
    expect((await sharp(bytes).metadata()).orientation, 'orientation is kept').toBe(6)
  })
})

describe('previews by generation', () => {
  it('serves an immutable file of the model with an ETag; 304 on a match', async () => {
    const url = `/api/v1/lora/g/${generation}/thumb-640.webp`
    const response = await call(server.app, { method: 'GET', url, as: reader })
    expect(response.statusCode).toBe(200)
    expect(response.headers['x-accel-redirect']).toBe(
      `/_accel/derived/gen/${generation}/thumb-640.webp`,
    )
    expect(response.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(response.headers['content-type']).toBe('image/webp')
    const etag = String(response.headers.etag)
    const again = await server.app.inject({
      method: 'GET',
      url,
      headers: { cookie: `co_session=${reader}`, 'if-none-match': etag },
    })
    expect(again.statusCode).toBe(304)
  })

  it('the catalog points the cover and the file tile at the built thumbnail', async () => {
    const url = `/api/v1/lora/g/${generation}/thumb-640.webp`
    const index = await call(server.app, { method: 'GET', url: '/api/v1/lora/index', as: owner })
    const entry = index.json().items.find((e: { id: string }) => e.id === 'PPV-073')
    expect(entry.cover.url).toBe(url)
    const page = await call(server.app, { method: 'GET', url: '/api/v1/lora/i/PPV-073', as: owner })
    const files = page.json().files as { key: string; thumb: { url: string | null } }[]
    expect(files.find((f) => f.key === 'master')?.thumb.url).toBe(url)
    expect(files.find((f) => f.key === 'pic01')?.thumb.url ?? null, 'not built yet').toBeNull()
  })

  it('another model never reaches it: 403 without rights, 404 inside another model', async () => {
    const foreign = await addPerson(server.app, owner, {
      name: 'Аня',
      login: 'anya-previews',
      role: 'manager',
      models: ['ari'],
    })
    const url = `/api/v1/lora/g/${generation}/thumb-640.webp`
    expect((await call(server.app, { method: 'GET', url, as: foreign.session })).statusCode).toBe(
      403,
    )
    const other = `/api/v1/ari/g/${generation}/thumb-640.webp`
    expect(
      (await call(server.app, { method: 'GET', url: other, as: foreign.session })).statusCode,
    ).toBe(404)
    expect((await call(server.app, { method: 'GET', url: other, as: owner })).statusCode).toBe(404)
  })
})
