import { randomBytes } from 'node:crypto'
import { enqueueWork, type values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCatalogItems } from '../testing/catalog-factory'
import { type TestServer, testServer } from '../testing/server'
import { collectGenerations } from './collector'
import { createMediaEnv, type MediaEnv } from './pipeline'
import { enqueueRebuilds, REBUILD_PRIORITY, rebuildKey } from './rebuild'
import { activateGeneration, bindGenerations } from './renditions'
import { shaBytes } from './storage'
import { registerBlob } from './storage-ops'
import { modelId, systemTx, tempFile } from './testing'

/**
 * The background rebuild (SPEC §9.1): a master whose previews are of a recipe that no longer
 * applies to it gets one `derive_video`; an SDR master on its recipes gets none; a repeat puts
 * nothing. HDR previews moved to their own recipes on 17.11.2026 (SPEC §9.3).
 */

let server: TestServer
let env: MediaEnv
let lora: string
let ordinal = 100

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

type VideoKind = 'preview' | 'poster' | 'thumb320' | 'thumb640' | 'frames'
const KINDS: VideoKind[] = ['preview', 'poster', 'thumb320', 'thumb640', 'frames']

/** A present video master held by an accepted object, its probe row and its active previews. */
async function master(input: { hdr: boolean; recipes: 'sdr' | 'hdr' }): Promise<Buffer> {
  const file = await tempFile(`a master video ${randomBytes(8).toString('hex')}`, 'file.mp4')
  await registerBlob(server.db, server.store, {
    file: file.path,
    sha256: file.sha256,
    ext: 'mp4',
    mediaKind: 'video',
    owner: 'worker:test:1',
  })
  const sha = shaBytes(file.sha256)
  ordinal += 1
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'ppv',
      number: ordinal,
      title: 'Тестовый ролик',
      titleEn: 'test clip',
      files: [{ role: 'master', durationS: 60, sha256: [sha], width: 1080, height: 1920 }],
    },
  ])
  await server.db.execute(sql`
    INSERT INTO blob_probes (sha256, kind, recipe_digest, is_hdr, raw)
    VALUES (${sha}, 'ffprobe', ${env.recipes.probeVideo.digest}, ${input.hdr}, '{}'::jsonb)`)
  const recipes = input.recipes === 'hdr' ? env.recipes.videoHdr : env.recipes.video
  for (const kind of KINDS) await generation(sha, kind, recipes[kind].digest)
  return sha
}

async function generation(sha: Buffer, kind: values.RenditionKind, digest: string) {
  const { rows } = await server.db.execute<{ id: string }>(sql`
    INSERT INTO rendition_generations (
      master_sha256, kind, recipe_digest, input_kind, input_sha256, state, ready_at
    ) VALUES (${sha}, ${kind}, ${digest}, 'master', ${sha}, 'ready', now())
    RETURNING id`)
  const id = rows[0]?.id as string
  await systemTx(server.db, (tx) => activateGeneration(tx, id))
  return id
}

async function rebuilds(sha: Buffer) {
  const { rows } = await server.db.execute<{ work_key: string; priority: number }>(sql`
    SELECT work_key, priority FROM work_operations
     WHERE kind = 'derive_video' AND input_sha256 = ${sha}`)
  return rows
}

async function active(sha: Buffer, kind: VideoKind) {
  const { rows } = await server.db.execute<{ recipe_digest: string }>(sql`
    SELECT recipe_digest FROM rendition_generations
     WHERE master_sha256 = ${sha} AND kind = ${kind} AND is_active`)
  return rows.map((r) => r.recipe_digest)
}

beforeAll(async () => {
  server = await testServer()
  lora = await modelId(server.db, 'lora')
  env = await createMediaEnv({
    db: server.db,
    store: server.store,
    lp: 4,
    owner: 'worker-video:test',
    log: () => {},
    versions: FAKE_VERSIONS,
  })
})
afterAll(() => server.close())

describe('rebuild of renditions by the current recipes', () => {
  it('an HDR master on the old recipes gets one work; SDR and rebuilt ones get none', async () => {
    const stale = await master({ hdr: true, recipes: 'sdr' })
    const sdr = await master({ hdr: false, recipes: 'sdr' })
    const rebuilt = await master({ hdr: true, recipes: 'hdr' })

    expect(await enqueueRebuilds(server.db, env)).toBe(1)
    expect(await rebuilds(stale)).toEqual([
      {
        work_key: rebuildKey(env.pipelineVersion, stale.toString('hex')),
        priority: REBUILD_PRIORITY,
      },
    ])
    expect(await rebuilds(sdr)).toEqual([])
    expect(await rebuilds(rebuilt)).toEqual([])

    // A restart puts nothing twice, also once the work is finished or failed.
    expect(await enqueueRebuilds(server.db, env)).toBe(0)
    await server.db.execute(sql`
      UPDATE work_operations SET state = 'failed', finished_at = now()
       WHERE kind = 'derive_video' AND input_sha256 = ${stale}`)
    expect(await enqueueRebuilds(server.db, env)).toBe(0)
  })

  it('leaves bytes with an unfinished derive to it and keeps to the batch', async () => {
    const busy = await master({ hdr: true, recipes: 'sdr' })
    await enqueueWork(server.db, {
      modelId: lora,
      kind: 'derive_video',
      workKey: `derive:${busy.toString('hex')}:intake`,
      inputSha256: busy,
      priority: 10,
    })
    const a = await master({ hdr: true, recipes: 'sdr' })
    const b = await master({ hdr: true, recipes: 'sdr' })
    expect(await enqueueRebuilds(server.db, env, 1)).toBe(1)
    expect(await enqueueRebuilds(server.db, env, 1)).toBe(0)
    await server.db.execute(sql`
      UPDATE work_operations SET state = 'succeeded', finished_at = now()
       WHERE kind = 'derive_video' AND work_key LIKE 'rebuild:%'`)
    expect(await enqueueRebuilds(server.db, env, 1)).toBe(1)
    expect((await rebuilds(a)).length + (await rebuilds(b)).length).toBe(2)
    expect((await rebuilds(busy)).map((w) => w.work_key)).toEqual([
      `derive:${busy.toString('hex')}:intake`,
    ])
  })

  it('a new generation by the applying recipe replaces the old one as the active', async () => {
    const sha = await master({ hdr: true, recipes: 'sdr' })
    const { rows } = await server.db.execute<{ id: string }>(sql`
      SELECT id FROM rendition_generations WHERE master_sha256 = ${sha} AND kind = 'preview'`)
    const old = rows[0]?.id as string
    const fresh = await generation(sha, 'preview', env.recipes.videoHdr.preview.digest)
    expect(await active(sha, 'preview')).toEqual([env.recipes.videoHdr.preview.digest])
    expect(await active(sha, 'poster')).toEqual([env.recipes.video.poster.digest])
    // A late bind of an older build never undoes the rebuild.
    await systemTx(server.db, (tx) => bindGenerations(tx, sha, sha))
    expect(await active(sha, 'preview')).toEqual([env.recipes.videoHdr.preview.digest])
    // The old one goes once the new one has served a day; the SDR-recipe poster stays.
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([])
    await server.db.execute(sql`
      UPDATE rendition_generations SET ready_at = now() - interval '25 hours'
       WHERE id = ${fresh}::uuid`)
    expect((await collectGenerations(server.db, server.store)).evicted).toEqual([old])
  })
})
