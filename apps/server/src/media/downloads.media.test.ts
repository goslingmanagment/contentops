import { execFileSync } from 'node:child_process'
import { type values, WorkRunner } from '@contentops/db'
import { probeVideo, sha256File } from '@contentops/media'
import type {} from '@contentops/media/testing/global-setup'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'
import { createCatalogItems } from '../testing/catalog-factory'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from '../testing/server'
import { createMediaEnv, type MediaEnv } from './pipeline'
import { mediaHandlers } from './roles'
import { extOfName, shaBytes } from './storage'
import { registerBlob } from './storage-ops'

/**
 * PLAN 2б «выдача с очисткой метаданных и подготовкой копий идёт тем же путём скачивания;
 * квитанция описывает выданные байты»: «Для заливки» without a plan builds the platform copy
 * (202 → ready), the next download takes it from the cache, the compatible copy is built on
 * request and not kept, a stripped master and a set's frames come from the exports folder.
 */

const fx = inject('fixtures')
let server: TestServer
let owner: string
let env: MediaEnv
const runners: WorkRunner[] = []

async function blobOf(name: keyof typeof fx.files, kind: 'video' | 'image'): Promise<string> {
  const path = fx.files[name]
  const sha = await sha256File(path)
  await registerBlob(server.db, server.store, {
    file: path,
    sha256: sha,
    ext: extOfName(path),
    mediaKind: kind,
    owner: 'worker:test:1',
  })
  return sha
}

function start(role: values.WorkRole) {
  const runner = new WorkRunner({
    db: server.db,
    role,
    handlers: mediaHandlers(role, env),
    pollMs: 50,
    limits: { encode: 2, copy: 1, image: 2 },
  })
  runners.push(runner)
  runner.start()
}

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  env = await createMediaEnv({
    db: server.db,
    store: server.store,
    lp: 4,
    owner: 'test:downloads',
    log: () => {},
  })
  const video = await blobOf('vertical', 'video')
  const probe = await probeVideo(fx.files.vertical)
  const [jpg, png, heic] = [
    await blobOf('rotatedJpeg', 'image'),
    await blobOf('smallPng', 'image'),
    await blobOf('heic48mp', 'image'),
  ]
  await createCatalogItems(server.db, 'lora', [
    {
      type: 'ppv',
      number: 74,
      title: 'Тестовая таблица',
      titleEn: 'test pattern',
      files: [
        {
          role: 'master',
          sha256: [shaBytes(video)],
          durationS: probe.durationMs / 1000,
          width: probe.video.displayWidth,
          height: probe.video.displayHeight,
          ext: 'mov',
          mime: 'video/quicktime',
        },
      ],
    },
    {
      type: 'set',
      number: 69,
      title: 'Шумы и полосы',
      files: [jpg, png, heic].map((sha, i) => ({
        role: 'raw' as const,
        sha256: [shaBytes(sha as string)],
        selected: i !== 1,
      })),
    },
  ])
  start('worker-video')
  start('worker')
})
afterAll(async () => {
  await Promise.all(runners.map((r) => r.stop()))
  await server.close()
})

async function download(id: string, body: Record<string, unknown>) {
  const response = await call(server.app, {
    method: 'POST',
    url: `/api/v1/lora/i/${id}/downloads`,
    as: owner,
    key: newKey(),
    body: { account: null, ...body },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

async function settle(answer: { kind: string; status_url?: string; download_url?: string }) {
  if (answer.kind === 'ready') return answer
  return vi.waitFor(
    async () => {
      const op = (
        await call(server.app, { method: 'GET', url: answer.status_url as string, as: owner })
      ).json()
      if (op.state === 'failed')
        throw Object.assign(new Error(JSON.stringify(op.error)), { fatal: true })
      if (op.state !== 'done') throw new Error(op.state)
      return { kind: 'ready', ...op.result }
    },
    { timeout: 240_000, interval: 200 },
  )
}

async function fetchFile(url: string) {
  const response = await call(server.app, { method: 'GET', url, as: owner })
  expect(response.statusCode).toBe(200)
  const accel = String(response.headers['x-accel-redirect'])
  const key = decodeURIComponent(accel.replace(/^\/_accel\/(tmp\/)?/, ''))
  const path = server.store.path(
    accel.startsWith('/_accel/derived/') ? `derived/${key.slice('derived/'.length)}` : key,
  )
  return { response, accel, path }
}

describe('«Для заливки» without a plan', () => {
  it('builds the copy (202 → ready), then the next download takes it from the cache', async () => {
    const first = await download('PPV-074', { kind: 'platform', strip_metadata: true })
    expect(first.kind).toBe('operation')
    const ready = await settle(first)
    expect(ready.file_name).toMatch(/^PPV-074_test-pattern_master__\d+m\d{2}s\.mp4$/)
    const { accel, path } = await fetchFile(ready.download_url)
    expect(accel).toMatch(/^\/_accel\/derived\/gen\/[0-9a-f-]+\/platform\.mp4$/)
    const receipt = ready.download_url.split('/').pop()
    const { rows } = await server.db.execute<{
      artifact: string | null
      sha: Buffer
      stripped: boolean
    }>(sql`
      SELECT e.rendition_artifact_id AS artifact, e.output_sha256 AS sha, r.meta_stripped AS stripped
        FROM download_receipts r JOIN download_receipt_entries e ON e.receipt_id = r.id
       WHERE r.id = ${receipt}::uuid`)
    expect(rows[0]).toMatchObject({ stripped: true })
    expect(rows[0]?.artifact).not.toBeNull()
    expect(rows[0]?.sha.toString('hex')).toBe(await sha256File(path))
    expect((await probeVideo(path)).video.codec).toBe('h264')

    const again = await download('PPV-074', { kind: 'platform', strip_metadata: true })
    expect(again).toMatchObject({ kind: 'ready', file_name: ready.file_name })
    const { rows: copies } = await server.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM work_operations WHERE kind = 'render'`,
    )
    expect(copies[0]?.n, 'one encode for both downloads').toBe(1)
  })
})

describe('copies on request', () => {
  it('the compatible copy goes to the exports folder and is not kept as a rendition', async () => {
    const ready = await settle(await download('PPV-074', { kind: 'compat', strip_metadata: false }))
    const { accel, path } = await fetchFile(ready.download_url)
    expect(accel).toMatch(/^\/_accel\/tmp\/exports\/[0-9a-f-]+\/1\/compat\/compatible\.mp4$/)
    expect((await probeVideo(path)).video).toMatchObject({ codec: 'h264', pixFmt: 'yuv420p' })
  })

  it('«Мастер (для монтажа)» with «стереть метаданные» issues a stripped master', async () => {
    const ready = await settle(await download('PPV-074', { kind: 'master', strip_metadata: true }))
    expect(ready.file_name).toMatch(/^PPV-074_test-pattern_master__\d+m\d{2}s\.mov$/)
    const { path } = await fetchFile(ready.download_url)
    const probe = await probeVideo(path)
    expect(Object.keys(probe.tags).filter((k) => /make|model|location|creation/i.test(k))).toEqual(
      [],
    )
  })
})

describe('set «Для заливки»', () => {
  it('gives the picked frames in order as ed01… in one ZIP', async () => {
    const ready = await settle(
      await download('SET-069', { kind: 'platform', strip_metadata: true }),
    )
    expect(ready.file_name).toBe('SET-069_shumy-polosy_ed.zip')
    const { path } = await fetchFile(ready.download_url)
    const names = execFileSync('python3', [
      '-c',
      'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
      path,
    ])
      .toString()
      .trim()
      .split('\n')
    expect(names).toEqual(['SET-069_shumy-polosy_ed01.jpg', 'SET-069_shumy-polosy_ed02.jpg'])
  })
})
