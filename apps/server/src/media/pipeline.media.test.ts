import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  bootstrap,
  createDb,
  createPool,
  type Db,
  type EnqueueInput,
  enqueueWork,
  type values,
  WorkRunner,
} from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import { probePhoto, probeVideo, sha256File } from '@contentops/media'
import type { FixtureName } from '@contentops/media/testing'
import type {} from '@contentops/media/testing/global-setup'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { BOOTSTRAP, OWNER } from '../testing/server'
import { createMediaEnv, type MediaEnv } from './pipeline'
import { mediaHandlers } from './roles'
import { type BlobStore, extOfName, shaBytes } from './storage'
import { modelId, seedItem, systemTx, tempStore } from './testing'
import { compatKey, renderKey, uniqKey } from './work/copies'
import { frameKey } from './work/frame'

/**
 * PLAN 2б on generated fixtures (no people): the worker roles' handlers through the real
 * executor — renditions in one pass and from the cache, master verdicts into
 * `master_checks`, binding of the first renditions after the master check, copies,
 * frames and unique versions, and no half files after an abort.
 */

const fx = inject('fixtures')
let database: TestDatabase
let pool: ReturnType<typeof createPool>
let db: Db
let store: BlobStore
let env: MediaEnv
let lora: string
const runners: WorkRunner[] = []

beforeAll(async () => {
  database = await createTestDatabase()
  pool = createPool(database.url(), { max: 20 })
  db = createDb(pool)
  await bootstrap(db, BOOTSTRAP, { env: { CONTENTOPS_OWNER_PASSWORD: OWNER.password } })
  lora = await modelId(db, 'lora')
  store = await tempStore('pipeline')
  env = await createMediaEnv({ db, store, lp: 4, owner: 'test:media', log: () => {} })
})
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop()))
})
afterAll(async () => {
  await pool.end()
  await database.drop()
})

function start(role: values.WorkRole): WorkRunner {
  const runner = new WorkRunner({
    db,
    role,
    handlers: mediaHandlers(role, env),
    pollMs: 50,
    leaseMs: 30_000,
    limits: { encode: 2, copy: 1, image: 2 },
    owner: `${role}:test:${randomUUID().slice(0, 6)}`,
    maxAttempts: 2,
    backoffMs: () => 50,
  })
  runners.push(runner)
  runner.start()
  return runner
}

/** A source left by intake in `staging/` (SPEC §9.1); returns its hex SHA-256. */
async function stage(name: FixtureName): Promise<string> {
  const file = fx.files[name]
  const sha = await sha256File(file)
  await mkdir(store.stagingDir, { recursive: true })
  await copyFile(file, join(store.stagingDir, `${sha}.${extOfName(file)}`))
  return sha
}

async function enqueue(input: Omit<EnqueueInput, 'modelId'> & { modelId?: string | null }) {
  const { work } = await enqueueWork(db, {
    modelId: lora,
    pipelineVersion: env.pipelineVersion,
    ...input,
  })
  return work.id
}

async function finished(id: string, timeout = 280_000) {
  return vi.waitFor(
    async () => {
      const { rows } = await db.execute<{
        state: string
        error_code: string | null
        error_text: string | null
        report: Record<string, unknown> | null
        output_ref: string | null
      }>(
        sql`SELECT state, error_code, error_text, report, output_ref FROM work_operations WHERE id = ${id}::uuid`,
      )
      const row = rows[0]
      if (!row || !['succeeded', 'failed'].includes(row.state)) throw new Error('not yet')
      return row
    },
    { timeout, interval: 100 },
  )
}

async function generations(input: string) {
  const { rows } = await db.execute<{
    id: string
    kind: string
    state: string
    is_active: boolean
    master_sha256: Buffer | null
    input_kind: string
    bound_at: string | null
  }>(sql`
    SELECT id, kind, state, is_active, master_sha256, input_kind, bound_at FROM rendition_generations
     WHERE input_sha256 = ${shaBytes(input)} ORDER BY kind, created_at`)
  return rows
}

async function artifacts(generationId: string) {
  const { rows } = await db.execute<{
    name: string
    storage_key: string
    output_sha256: Buffer
  }>(sql`
    SELECT name, storage_key, output_sha256 FROM rendition_artifacts
     WHERE generation_id = ${generationId}::uuid ORDER BY name`)
  return rows
}

async function checks(source: string) {
  const { rows } = await db.execute<{
    decision: string | null
    verdict: string
    master_sha256: Buffer | null
    report: { acceptance: string }
  }>(sql`SELECT decision, verdict, master_sha256, report FROM master_checks
          WHERE source_sha256 = ${shaBytes(source)} ORDER BY created_at`)
  return rows
}

async function blob(sha: string) {
  const { rows } = await db.execute<{ state: string; storage_key: string; ext: string }>(
    sql`SELECT state, storage_key, ext FROM blobs WHERE sha256 = ${shaBytes(sha)}`,
  )
  return rows[0]
}

/** A draft of intake from a disk source with its staged bytes (schema §3.4). */
async function draftFor(sourceSha: string): Promise<string> {
  return systemTx(db, async (tx) => {
    const tag = randomUUID().slice(0, 8)
    const source = await tx.execute<{ id: string }>(sql`
      INSERT INTO sources (model_id, kind, label, read_only, root_path, credentials_ref)
      VALUES (${lora}::uuid, 'yandex_disk', ${`disk-${tag}`}, true, 'disk:/', 'YDISK_TOKEN')
      RETURNING id`)
    const sourceId = source.rows[0]?.id
    const object = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
      VALUES (${lora}::uuid, ${sourceId}::uuid, ${tag}, ${`/fixtures/${tag}.mov`}, ${`${tag}.mov`})
      RETURNING id`)
    const revision = await tx.execute<{ id: string }>(sql`
      INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size)
      VALUES (${lora}::uuid, ${object.rows[0]?.id}::uuid, 1, 1) RETURNING id`)
    const group = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_groups (model_id, source_id, group_key, grouping)
      VALUES (${lora}::uuid, ${sourceId}::uuid, ${`single:${tag}`}, 'single') RETURNING id`)
    const draft = await tx.execute<{ id: string }>(sql`
      INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, state, source_sha256)
      VALUES (${lora}::uuid, ${group.rows[0]?.id}::uuid, ${revision.rows[0]?.id}::uuid, 'disk_scan',
              'processing', ${shaBytes(sourceSha)})
      RETURNING id`)
    return draft.rows[0]?.id as string
  })
}

describe('derive_video — one pass, then the cache', () => {
  it('builds preview, poster, thumbs and frames from the source, unbound until the master', async () => {
    start('worker-video')
    const sha = await stage('scenes')
    const first = await finished(
      await enqueue({ kind: 'derive_video', workKey: `derive:${sha}`, inputSha256: shaBytes(sha) }),
    )
    expect(first).toMatchObject({ state: 'succeeded' })
    const gens = await generations(sha)
    expect(gens.map((g) => g.kind).sort()).toEqual([
      'frames',
      'poster',
      'preview',
      'thumb320',
      'thumb640',
    ])
    for (const g of gens) {
      expect(g).toMatchObject({
        state: 'ready',
        input_kind: 'source',
        master_sha256: null,
        is_active: false,
      })
      for (const a of await artifacts(g.id)) {
        expect(a.storage_key).toBe(`derived/gen/${g.id}/${a.name}`)
        expect(await sha256File(store.path(a.storage_key))).toBe(a.output_sha256.toString('hex'))
      }
    }
    const frames = await artifacts(gens.find((g) => g.kind === 'frames')?.id as string)
    expect(frames.length).toBeGreaterThan(1)

    const again = await finished(
      await enqueue({
        kind: 'derive_video',
        workKey: `derive-again:${sha}`,
        inputSha256: shaBytes(sha),
      }),
    )
    expect(again.report).toMatchObject({ cached: true })
    expect(await generations(sha)).toHaveLength(5)
    expect(await readdir(store.derivedTmpDir)).toEqual([])
  })
})

describe('encode_master — verdicts into master_checks', () => {
  it('encodes, verifies, registers the master and binds the first renditions to it', async () => {
    start('worker-video')
    const sha = await stage('vfr120')
    const draft = await draftFor(sha)
    await finished(
      await enqueue({ kind: 'derive_video', workKey: `derive:${sha}`, inputSha256: shaBytes(sha) }),
    )
    const id = await enqueue({
      kind: 'encode_master',
      workKey: `master:${sha}:${env.recipes.master.digest}`,
      inputSha256: shaBytes(sha),
      draftId: draft,
    })
    const done = await finished(id)
    expect(done).toMatchObject({
      state: 'succeeded',
      report: { decision: 'encode', verdict: 'ok', acceptance: 'master_encoded' },
    })
    const [check] = await checks(sha)
    expect(check).toMatchObject({ decision: 'encode', verdict: 'ok' })
    const master = (check?.master_sha256 ?? Buffer.alloc(0)).toString('hex')
    expect(master).not.toBe(sha)
    expect(await blob(master)).toMatchObject({ state: 'present', ext: 'mp4' })
    expect(
      (await probeVideo(store.path((await blob(master))?.storage_key as string))).video.codec,
    ).toBe('av1')

    const { rows } = await db.execute<{
      master: Buffer
      verified: boolean
      is_source: boolean
      blocked: string | null
    }>(sql`
      SELECT master_sha256 AS master, master_verified_at IS NOT NULL AS verified,
             master_is_source AS is_source, blocked_reason AS blocked
        FROM inbox_drafts WHERE id = ${draft}::uuid`)
    expect(rows[0]).toMatchObject({ verified: true, is_source: false, blocked: null })
    expect(rows[0]?.master.toString('hex')).toBe(master)

    for (const g of await generations(sha)) {
      expect(g.master_sha256?.toString('hex')).toBe(master)
      expect(g.bound_at).not.toBeNull()
      expect(g.is_active).toBe(true)
    }

    // The same source and recipe again: no second encode.
    const again = await finished(
      await enqueue({
        kind: 'encode_master',
        workKey: `master-again:${sha}`,
        inputSha256: shaBytes(sha),
      }),
    )
    expect(again.report).toHaveProperty('reused_check')
    expect(await checks(sha)).toHaveLength(1)
  })

  it.each([
    ['lowrate', 'skipped_lowrate', 'ok', 'master_is_source'],
    ['hdr4k60', 'skipped_hdr', 'ok', 'master_is_source'],
    ['bigger', 'encode', 'bigger_than_source', 'master_is_source'],
    ['truncated', 'encode', 'source_truncated', 'accept_as_is_only'],
  ] as const)(
    '%s → %s / %s: the source is kept as the master',
    async (name, decision, verdict, acceptance) => {
      start('worker-video')
      const sha = await stage(name)
      const draft = await draftFor(sha)
      const done = await finished(
        await enqueue({
          kind: 'encode_master',
          workKey: `master:${sha}`,
          inputSha256: shaBytes(sha),
          draftId: draft,
        }),
      )
      expect(done.state).toBe('succeeded')
      const [check] = await checks(sha)
      expect(check).toMatchObject({ verdict, report: { acceptance } })
      if (verdict !== 'source_truncated') expect(check?.decision).toBe(decision)
      expect(check?.master_sha256?.toString('hex')).toBe(sha)
      expect(await blob(sha)).toMatchObject({ state: 'present', ext: extOfName(fx.files[name]) })
      const { rows } = await db.execute<{
        verified: boolean
        is_source: boolean
        blocked: string | null
      }>(sql`
      SELECT master_verified_at IS NOT NULL AS verified, master_is_source AS is_source,
             blocked_reason AS blocked FROM inbox_drafts WHERE id = ${draft}::uuid`)
      expect(rows[0]).toMatchObject(
        acceptance === 'master_is_source'
          ? { verified: true, is_source: true, blocked: null }
          : { verified: false, blocked: 'master_failed' },
      )
    },
  )

  it('an unreadable source keeps no bytes and waits for a replacement', async () => {
    start('worker-video')
    const sha = await stage('unreadable')
    const draft = await draftFor(sha)
    const done = await finished(
      await enqueue({
        kind: 'encode_master',
        workKey: `master:${sha}`,
        inputSha256: shaBytes(sha),
        draftId: draft,
      }),
    )
    expect(done.state).toBe('succeeded')
    expect(await checks(sha)).toMatchObject([
      { decision: null, verdict: 'unreadable', master_sha256: null },
    ])
    expect(await blob(sha)).toBeUndefined()
    const { rows } = await db.execute<{ blocked: string | null }>(sql`
      SELECT blocked_reason AS blocked FROM inbox_drafts WHERE id = ${draft}::uuid`)
    expect(rows[0]?.blocked).toBe('master_failed')
  })
})

describe('copies and durable results from a master', () => {
  let master: string
  let ppv: Awaited<ReturnType<typeof seedItem>>

  beforeAll(async () => {
    const sha = await stage('lowrate')
    const runner = start('worker-video')
    await finished(
      await enqueue({
        kind: 'encode_master',
        workKey: `master:${sha}`,
        inputSha256: shaBytes(sha),
      }),
    )
    await runner.stop()
    master = sha
    const probe = await probeVideo(fx.files.lowrate)
    ppv = await seedItem(db, {
      model: lora,
      type: 'PPV',
      number: 501,
      title: 'Тестовая таблица',
      files: [
        {
          role: 'master',
          mediaKind: 'video',
          master,
          durationMs: probe.durationMs,
          width: probe.video.displayWidth,
          height: probe.video.displayHeight,
        },
      ],
    })
  })

  it('render: platform.mp4 under its key and strip mode, built once', async () => {
    start('worker-video')
    for (const stripped of [false, true]) {
      const digest = (stripped ? env.recipes.platform.stripped : env.recipes.platform.kept).digest
      const done = await finished(
        await enqueue({
          kind: 'render',
          workKey: renderKey(master, digest),
          inputSha256: shaBytes(master),
          scope: stripped ? 'stripped' : 'kept',
          recipeDigest: digest,
        }),
      )
      expect(done.state).toBe('succeeded')
      const generation = done.output_ref as string
      const [file] = await artifacts(generation)
      expect(file?.name).toBe('platform.mp4')
      const probe = await probeVideo(store.path(file?.storage_key as string))
      expect(probe.video.codec).toBe('h264')
      if (stripped)
        expect(probe.tags.make ?? probe.tags['com.apple.quicktime.make']).toBeUndefined()
      const cached = await finished(
        await enqueue({
          kind: 'render',
          workKey: `${renderKey(master, digest)}:again`,
          inputSha256: shaBytes(master),
          scope: stripped ? 'stripped' : 'kept',
          recipeDigest: digest,
        }),
      )
      expect(cached).toMatchObject({ output_ref: generation, report: { cached: true } })
    }
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM rendition_generations
       WHERE master_sha256 = ${shaBytes(master)} AND kind = 'platform' AND is_active`)
    expect(rows[0]?.n).toBe(2)
  })

  it('render_compat: an H.264 copy in the exports folder of the receipt, not kept', async () => {
    start('worker-video')
    const receipt = randomUUID()
    const done = await finished(
      await enqueue({
        kind: 'render_compat',
        workKey: compatKey(receipt),
        inputSha256: shaBytes(master),
        scope: 'stripped',
      }),
    )
    expect(done.state).toBe('succeeded')
    const file = (done.report as { file: { key: string; sha256: string } }).file
    expect(file.key).toBe(`exports/${receipt}/compat/compatible.mp4`)
    expect(await sha256File(store.path(file.key))).toBe(file.sha256)
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM rendition_generations WHERE master_sha256 = ${shaBytes(master)} AND kind NOT IN ('platform')`)
    expect(rows[0]?.n, 'no rendition for a compat copy').toBe(0)
  })

  it('extract_frame: «Сделать обложкой» adds a full-size photo, the cover and its thumbnails', async () => {
    start('worker-video')
    start('worker-image')
    const version = ppv.files[0]?.versionId as string
    const done = await finished(
      await enqueue({
        kind: 'extract_frame',
        workKey: frameKey(version, 1200, 'cover'),
        assetVersionId: version,
      }),
    )
    expect(done.state).toBe('succeeded')
    const { rows } = await db.execute<{
      role: string
      sha: Buffer
      cover: boolean
      relation: string
    }>(sql`
      SELECT m.role, v.master_sha256 AS sha, i.cover_membership_id = m.id AS cover, p.relation
        FROM item_memberships m
        JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
        JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
        JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id
        JOIN provenance p ON p.model_id = v.model_id AND p.child_version_id = v.id
       WHERE m.item_id = ${ppv.itemId}::uuid AND a.media_kind = 'image'`)
    expect(rows).toMatchObject([{ role: 'thumb', cover: true, relation: 'frame_from' }])
    const photo = rows[0]?.sha.toString('hex') as string
    const meta = await probePhoto(store.path((await blob(photo))?.storage_key as string))
    expect(meta.width).toBeGreaterThan(0)
    const derive = await db.execute<{ id: string }>(sql`
      SELECT id FROM work_operations WHERE kind = 'derive_image' AND input_sha256 = ${shaBytes(photo)}`)
    await finished(derive.rows[0]?.id as string)
    const gens = await generations(photo)
    expect(gens.map((g) => [g.kind, g.is_active])).toEqual(
      expect.arrayContaining([
        ['thumb320', true],
        ['thumb640', true],
        ['preview2048', true],
      ]),
    )
  })

  it('uniq_render: a unique FYP version is a durable asset uN with provenance', async () => {
    start('worker-video')
    const fyp = await seedItem(db, {
      model: lora,
      type: 'FYP',
      number: 77,
      title: 'Фуп для версий',
      files: [{ role: 'master', mediaKind: 'video', master }],
    })
    const parent = fyp.files[0]?.versionId as string
    const done = await finished(
      await enqueue({
        kind: 'uniq_render',
        workKey: uniqKey(parent, 'mirror', 2),
        assetVersionId: parent,
      }),
    )
    expect(done.state).toBe('succeeded')
    const { rows } = await db.execute<{
      variant_no: number
      uniq_level: string
      params: { n: number; level: string; mirror: boolean }
    }>(sql`
      SELECT a.variant_no, a.uniq_level, p.params
        FROM assets a
        JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
        JOIN provenance p ON p.model_id = v.model_id AND p.child_version_id = v.id AND p.relation = 'uniq_from'
       WHERE a.created_in_item_id = ${fyp.itemId}::uuid AND a.variant_kind = 'uniq'`)
    expect(rows).toMatchObject([
      { variant_no: 2, uniq_level: 'mirror', params: { n: 2, level: 'mirror' } },
    ])
  })
})

describe('derive_image — EXIF, orientation, previews and pHash in one job', () => {
  it.each(['heic48mp', 'rotatedJpeg'] as const)('%s', async (name) => {
    start('worker-image')
    const sha = await stage(name)
    const done = await finished(
      await enqueue({ kind: 'derive_image', workKey: `derive:${sha}`, inputSha256: shaBytes(sha) }),
    )
    expect(done.state).toBe('succeeded')
    expect((await generations(sha)).map((g) => g.kind).sort()).toEqual([
      'frames',
      'preview2048',
      'thumb320',
      'thumb640',
    ])
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM blob_phashes WHERE sha256 = ${shaBytes(sha)})::int
           + (SELECT count(*) FROM blob_probes WHERE sha256 = ${shaBytes(sha)} AND kind = 'exif')::int AS n`)
    expect(rows[0]?.n).toBe(2)
    expect(await sha256File(fx.files[name]), 'the source is never changed').toBe(sha)
    const again = await finished(
      await enqueue({
        kind: 'derive_image',
        workKey: `derive-again:${sha}`,
        inputSha256: shaBytes(sha),
      }),
    )
    expect(again.report).toMatchObject({ cached: true })
  })
})

describe('abort', () => {
  it('a stopped role leaves no half-built files; the next attempt builds clean', async () => {
    const runner = start('worker-video')
    const sha = await stage('hdr4k60')
    const id = await enqueue({
      kind: 'derive_video',
      workKey: `derive-abort:${sha}`,
      inputSha256: shaBytes(sha),
    })
    await vi.waitFor(
      async () => {
        const { rows } = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM rendition_generations WHERE work_id = ${id}::uuid AND state = 'building'`)
        if ((rows[0]?.n ?? 0) === 0) throw new Error('not building yet')
      },
      { timeout: 60_000, interval: 20 },
    )
    await runner.stop()
    expect(await readdir(store.derivedTmpDir)).toEqual([])
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM rendition_generations WHERE work_id = ${id}::uuid`)
    for (const { id: generation } of rows) {
      expect(await store.exists(`derived/gen/${generation}`)).toBe(false)
    }
    start('worker-video')
    expect(await finished(id)).toMatchObject({ state: 'succeeded' })
    const states = await db.execute<{ state: string }>(sql`
      SELECT state FROM rendition_generations WHERE work_id = ${id}::uuid ORDER BY state`)
    expect(new Set(states.rows.map((r) => r.state))).toEqual(new Set(['failed', 'ready']))
  })
})
