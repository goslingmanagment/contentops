import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bootstrap, createDb, createPool, type Db, WorkRunner } from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP, OWNER } from '../testing/server'
import { sweepExports } from './roles'
import { type BlobStore, blobKey, shaBytes } from './storage'
import { registerBlob } from './storage-ops'
import { modelId, seedItem, tempFile, tempStore } from './testing'
import { enqueueVerifyBlobs, type VerifyReport, verifyBlobsHandler } from './work/verify-blobs'

/**
 * `verify-blobs` (SPEC §9.1, §11.2): hashes on disk against the database, files without a
 * row, blobs without references — a report on the work row; nothing is removed.
 */

let database: TestDatabase
let pool: ReturnType<typeof createPool>
let db: Db
let store: BlobStore

beforeAll(async () => {
  database = await createTestDatabase()
  pool = createPool(database.url(), { max: 10 })
  db = createDb(pool)
  await bootstrap(db, BOOTSTRAP, { env: { CONTENTOPS_OWNER_PASSWORD: OWNER.password } })
  store = await tempStore('verify')
})
afterAll(async () => {
  await pool.end()
  await database.drop()
})

async function put(bytes: string, ext = 'mp4'): Promise<string> {
  const file = await tempFile(bytes)
  await registerBlob(db, store, {
    file: file.path,
    sha256: file.sha256,
    ext,
    mediaKind: 'video',
    owner: 'worker:test:1',
  })
  return file.sha256
}

describe('verify-blobs', () => {
  it('reports damaged, missing, stray and unreferenced bytes and marks the rows', async () => {
    const held = await put('a master of PPV-301')
    await seedItem(db, {
      model: await modelId(db, 'lora'),
      type: 'PPV',
      number: 301,
      files: [{ role: 'master', mediaKind: 'video', master: held }],
    })
    const loose = await put('nobody holds this')
    const damaged = await put('will be damaged')
    await writeFile(store.path(blobKey(damaged, 'mp4')), 'will be dAmaged')
    const lost = await put('will be lost')
    await store.delete(blobKey(lost, 'mp4'))
    const stray = blobKey('ab'.repeat(32), 'jpg')
    await mkdir(dirname(store.path(stray)), { recursive: true })
    await writeFile(store.path(stray), 'stray')

    const runner = new WorkRunner({
      db,
      role: 'worker',
      handlers: { verify_blobs: verifyBlobsHandler({ db, store }) },
      pollMs: 20,
    })
    runner.start()
    const { work } = await enqueueVerifyBlobs(db)
    const report = await vi.waitFor(
      async () => {
        const { rows } = await db.execute<{ state: string; report: VerifyReport | null }>(
          sql`SELECT state, report FROM work_operations WHERE id = ${work.id}::uuid`,
        )
        if (rows[0]?.state !== 'succeeded') throw new Error('not yet')
        return rows[0].report as VerifyReport
      },
      { timeout: 10_000, interval: 20 },
    )
    await runner.stop()

    expect(report).toMatchObject({
      checked: 4,
      ok: 2,
      corrupt: [damaged],
      missing: [lost],
      orphans: [stray],
      unreferenced: [{ sha256: loose, key: blobKey(loose, 'mp4') }],
    })
    const { rows } = await db.execute<{ sha256: Buffer; state: string; verified: boolean }>(sql`
      SELECT sha256, state, verified_at IS NOT NULL AS verified FROM blobs ORDER BY registered_at`)
    const state = Object.fromEntries(rows.map((r) => [r.sha256.toString('hex'), r.state]))
    expect(state).toEqual({
      [held]: 'present',
      [loose]: 'present',
      [damaged]: 'corrupt',
      [lost]: 'missing',
    })
    expect(await store.exists(blobKey(loose, 'mp4')), 'nothing is removed').toBe(true)
    const verified = rows.find((r) => r.sha256.equals(shaBytes(held)))
    expect(verified?.verified).toBe(true)
  })
})

describe('exports folder', () => {
  it('removes issues older than a day and keeps fresh ones', async () => {
    const old = join(store.exportsDir, 'old-receipt')
    const fresh = join(store.exportsDir, 'fresh-receipt')
    for (const dir of [old, fresh]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'file.mp4'), 'x')
    }
    const now = Date.now()
    const dayAgo = (now - 25 * 60 * 60 * 1000) / 1000
    await utimes(old, dayAgo, dayAgo)
    expect(await sweepExports(store, now)).toEqual(['old-receipt'])
    expect(await store.exists('exports/old-receipt/file.mp4')).toBe(false)
    expect(await store.exists('exports/fresh-receipt/file.mp4')).toBe(true)
  })
})
