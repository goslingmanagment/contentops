import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { enqueueWork, type values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CreatedItem, createCatalogItems } from '../testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from '../testing/server'
import { collectGenerations, DAY_MS, HOLDERS } from './collector'
import { createMediaEnv, type MediaEnv } from './pipeline'
import { shaBytes } from './storage'
import { registerBlob } from './storage-ops'
import { modelId, systemTx, tempFile } from './testing'

/**
 * The generation collector (SPEC §9.1 «прежнее поколение отдаётся, пока новое не собрано,
 * потом его удаляет сборщик»; schema §3.3): files go, rows stay `evicted`.
 */

let server: TestServer
let env: MediaEnv
let owner: string
let lora: string
let ppv: CreatedItem
let master: string

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

const NAME: Partial<Record<values.RenditionKind, string>> = {
  thumb640: 'thumb-640.webp',
  frames: 'frames/0001.webp',
  platform: 'platform.mp4',
}

interface Built {
  id: string
  artifact: string
  key: string
}

/** A ready generation with one file, as the media roles leave it. */
async function generation(input: {
  master: Buffer | null
  kind: 'thumb640' | 'frames' | 'platform'
  digest: string
  active: boolean
  readyAgoMs: number
}): Promise<Built> {
  const db = server.db
  const source = input.master ?? randomBytes(32)
  const { rows } = await db.execute<{ id: string }>(sql`
    INSERT INTO rendition_generations (
      master_sha256, kind, recipe_digest, is_active, input_kind, input_sha256, state, ready_at
    ) VALUES (
      ${input.master}, ${input.kind}, ${input.digest}, ${input.active},
      ${input.master ? 'master' : 'source'}, ${source}, 'ready',
      now() - ${`${input.readyAgoMs} milliseconds`}::interval
    ) RETURNING id`)
  const id = rows[0]?.id as string
  const name = NAME[input.kind] as string
  const key = `derived/gen/${id}/${name}`
  const bytes = Buffer.from(`${input.kind} of generation ${id}`)
  await mkdir(dirname(server.store.path(key)), { recursive: true })
  await writeFile(server.store.path(key), bytes)
  const { rows: artifacts } = await db.execute<{ id: string }>(sql`
    INSERT INTO rendition_artifacts (
      generation_id, name, output_sha256, byte_size, mime, width, height, storage_key
    ) VALUES (
      ${id}::uuid, ${name}, ${createHash('sha256').update(bytes).digest()}, ${bytes.length},
      ${input.kind === 'platform' ? 'video/mp4' : 'image/webp'}, 1080, 1920, ${key}
    ) RETURNING id`)
  return { id, artifact: artifacts[0]?.id as string, key }
}

async function state(id: string) {
  const { rows } = await server.db.execute<{
    state: string
    is_active: boolean
    artifacts: string[]
  }>(sql`
    SELECT g.state, g.is_active,
           array(SELECT a.state FROM rendition_artifacts a WHERE a.generation_id = g.id) AS artifacts
      FROM rendition_generations g WHERE g.id = ${id}::uuid`)
  return rows[0]
}

const DAYS = (n: number) => n * DAY_MS
const thumbDigest = () => env.recipes.video.thumb640.digest

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  lora = await modelId(server.db, 'lora')
  env = await createMediaEnv({
    db: server.db,
    store: server.store,
    lp: 4,
    owner: 'worker:test',
    log: () => {},
    versions: FAKE_VERSIONS,
  })
  const file = await tempFile('a master video of PPV-091', 'file.mp4')
  await registerBlob(server.db, server.store, {
    file: file.path,
    sha256: file.sha256,
    ext: 'mp4',
    mediaKind: 'video',
    owner: 'worker:test:1',
  })
  master = file.sha256
  const [item] = await createCatalogItems(server.db, 'lora', [
    {
      type: 'ppv',
      number: 91,
      title: 'Тестовый ролик',
      titleEn: 'test clip',
      files: [
        { role: 'master', durationS: 60, sha256: [shaBytes(master)], width: 1080, height: 1920 },
      ],
    },
  ])
  ppv = item as CreatedItem
})
afterAll(() => server.close())

describe('generation collector', () => {
  it('removes a rebuilt generation after its successor served a day; rows stay evicted', async () => {
    const m = randomBytes(32)
    const old = await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: false,
      readyAgoMs: DAYS(3),
    })
    const now = await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: true,
      readyAgoMs: DAYS(2),
    })

    const report = await collectGenerations(server.db, server.store)
    expect(report.evicted).toEqual([old.id])
    expect(report.bytes).toBeGreaterThan(0)
    expect(await state(old.id)).toEqual({
      state: 'evicted',
      is_active: false,
      artifacts: ['evicted'],
    })
    expect(await server.store.exists(`derived/gen/${old.id}`)).toBe(false)
    expect(await state(now.id)).toMatchObject({ state: 'ready', is_active: true })
    expect(await server.store.exists(now.key)).toBe(true)
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
  })

  it('an old recipe goes once the current recipe has served a day, not before', async () => {
    const m = randomBytes(32)
    const old = await generation({
      master: m,
      kind: 'thumb640',
      digest: 'thumb640-recipe-of-an-older-image',
      active: true,
      readyAgoMs: DAYS(30),
    })
    const fresh = await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: true,
      readyAgoMs: 60 * 60 * 1000,
    })
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
    expect(await server.store.exists(old.key), 'still served while the new one is fresh').toBe(true)

    await server.db.execute(sql`
      UPDATE rendition_generations SET ready_at = now() - interval '25 hours'
       WHERE id = ${fresh.id}::uuid`)
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([old.id])
    expect(await state(old.id)).toMatchObject({ state: 'evicted', is_active: false })
  })

  it('keeps what nothing rebuilt: an old recipe alone, an unbound draft preview, the current one', async () => {
    const alone = await generation({
      master: randomBytes(32),
      kind: 'thumb640',
      digest: 'thumb640-recipe-of-an-older-image',
      active: true,
      readyAgoMs: DAYS(30),
    })
    const unbound = await generation({
      master: null,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: false,
      readyAgoMs: DAYS(30),
    })
    const m = randomBytes(32)
    const inactive = await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: false,
      readyAgoMs: DAYS(30),
    })
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
    for (const g of [alone, unbound, inactive]) {
      expect(await state(g.id)).toMatchObject({ state: 'ready' })
      expect(await server.store.exists(g.key)).toBe(true)
    }
  })

  it('a chronology frame and an unfinished work hold an old generation', async () => {
    const m = shaBytes(master)
    const version = ppv.files.get('master')?.versionIds.at(-1) as string
    const framesDigest = env.recipes.video.frames.digest
    const frames = await generation({
      master: m,
      kind: 'frames',
      digest: framesDigest,
      active: false,
      readyAgoMs: DAYS(3),
    })
    await generation({
      master: m,
      kind: 'frames',
      digest: framesDigest,
      active: true,
      readyAgoMs: DAYS(2),
    })
    await systemTx(server.db, (tx) =>
      tx.execute(sql`
      INSERT INTO chronology_entries (
        model_id, item_id, asset_version_id, at_ms, text, source, frame_artifact_id
      ) VALUES (
        ${lora}::uuid, ${ppv.uid}::uuid, ${version}::uuid, 1000, 'кадр для тизера', 'human',
        ${frames.artifact}::uuid
      )`),
    )

    const thumb = await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: false,
      readyAgoMs: DAYS(3),
    })
    await generation({
      master: m,
      kind: 'thumb640',
      digest: thumbDigest(),
      active: true,
      readyAgoMs: DAYS(2),
    })
    await enqueueWork(server.db, {
      modelId: lora,
      kind: 'render',
      workKey: `collector-test:${thumb.id}`,
      generationId: thumb.id,
    })

    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
    expect(await server.store.exists(frames.key)).toBe(true)
    expect(await server.store.exists(thumb.key)).toBe(true)
  })

  it('a fresh receipt holds the issued copy; after it the download asks to download again', async () => {
    const m = shaBytes(master)
    const digest = env.recipes.platform.kept.digest
    const issued = await generation({
      master: m,
      kind: 'platform',
      digest,
      active: true,
      readyAgoMs: DAYS(3),
    })
    const answer = await call(server.app, {
      method: 'POST',
      url: '/api/v1/lora/i/PPV-091/downloads',
      as: owner,
      key: newKey(),
      body: { kind: 'platform', strip_metadata: false, account: null },
    })
    expect(answer.statusCode).toBe(200)
    const url = answer.json().download_url as string
    expect(
      (await call(server.app, { method: 'GET', url, as: owner })).headers['x-accel-redirect'],
    ).toBe(`/_accel/${issued.key}`)

    // The copy is rebuilt (say, a new platform recipe) and the new one has served a day.
    await server.db.execute(sql`
      UPDATE rendition_generations SET is_active = false WHERE id = ${issued.id}::uuid`)
    await generation({ master: m, kind: 'platform', digest, active: true, readyAgoMs: DAYS(2) })

    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
    expect(await server.store.exists(issued.key), 'the receipt was issued today').toBe(true)

    // A day later the receipt no longer holds it.
    expect((await collectGenerations(server.db, server.store, { graceMs: 0 })).evicted).toEqual([
      issued.id,
    ])
    const gone = await call(server.app, { method: 'GET', url, as: owner })
    expect(gone.statusCode).toBe(404)
    expect(gone.json().message).toBe('Копия пересобрана — скачайте заново')
  })

  it('every reference to generations and artifacts in the schema is a holder', async () => {
    const { rows } = await server.db.execute<{ ref: string }>(sql`
      SELECT c.conrelid::regclass::text || '.' || a.attname AS ref
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.confrelid IN ('rendition_generations'::regclass, 'rendition_artifacts'::regclass)
       ORDER BY 1`)
    expect(
      rows.map((r) => r.ref),
      'a new reference: decide in media/collector.ts whether it holds an old generation',
    ).toEqual(Object.keys(HOLDERS).sort())
  })
})
