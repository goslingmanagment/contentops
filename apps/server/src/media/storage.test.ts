import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bootstrap, createDb, createPool, type Db } from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOOTSTRAP, OWNER } from '../testing/server'
import { createGeneration, finishGenerations } from './renditions'
import { type BlobStore, blobKey, HashMismatchError, shaBytes } from './storage'
import { purgeBlob, reconcileStorage, registerBlob, sweepIncoming } from './storage-ops'
import { modelId, seedItem, systemTx, tempFile, tempStore } from './testing'

/**
 * Bytes contract (schema §3.3, §5, §9.3, §9.4): verified bytes are placed by the storage
 * protocol, an interrupted operation is settled against the disk on restart, the owner's
 * purge checks references before and again after removing the file.
 */

let database: TestDatabase
let pool: ReturnType<typeof createPool>
let db: Db
let store: BlobStore
let lora: string
const OWNER_ID = 'worker-video:test:1'

beforeAll(async () => {
  database = await createTestDatabase()
  pool = createPool(database.url(), { max: 10 })
  db = createDb(pool)
  await bootstrap(db, BOOTSTRAP, { env: { CONTENTOPS_OWNER_PASSWORD: OWNER.password } })
  store = await tempStore('bytes')
  lora = await modelId(db, 'lora')
})
afterAll(async () => {
  await pool.end()
  await database.drop()
})

async function operations(sha: string) {
  const { rows } = await db.execute<{ kind: string; state: string; error: string | null }>(sql`
    SELECT kind, state, error FROM storage_operations WHERE blob_sha256 = ${shaBytes(sha)}
     ORDER BY created_at`)
  return rows
}

async function blobState(sha: string): Promise<string | undefined> {
  const { rows } = await db.execute<{ state: string }>(
    sql`SELECT state FROM blobs WHERE sha256 = ${shaBytes(sha)}`,
  )
  return rows[0]?.state
}

describe('put', () => {
  it('places verified bytes under blobs/sha256/ab/cd and registers them present', async () => {
    const file = await tempFile('master bytes 1', 'clip.mov')
    const put = await registerBlob(db, store, {
      file: file.path,
      sha256: file.sha256,
      ext: 'mov',
      mediaKind: 'video',
      owner: OWNER_ID,
    })
    expect(put).toMatchObject({ created: true, key: blobKey(file.sha256, 'mov') })
    expect(put.key).toMatch(/^blobs\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.mov$/)
    expect(await readFile(store.path(put.key), 'utf8')).toBe('master bytes 1')
    expect(await readFile(file.path, 'utf8'), 'a copy keeps the input').toBe('master bytes 1')
    expect(await blobState(file.sha256)).toBe('present')
    expect(await operations(file.sha256)).toEqual([
      { kind: 'put', state: 'committed', error: null },
    ])
    expect(await readdir(store.incomingDir)).toEqual([])

    const again = await registerBlob(db, store, {
      file: file.path,
      sha256: file.sha256,
      ext: 'mov',
      mediaKind: 'video',
      owner: OWNER_ID,
    })
    expect(again.created).toBe(false)
    expect(await operations(file.sha256)).toHaveLength(1)
  })

  it('refuses bytes that differ from their hash and leaves nothing behind', async () => {
    const file = await tempFile('these bytes')
    const wrong = (await tempFile('other bytes')).sha256
    await expect(
      registerBlob(db, store, {
        file: file.path,
        sha256: wrong,
        ext: 'jpg',
        mediaKind: 'image',
        owner: OWNER_ID,
      }),
    ).rejects.toBeInstanceOf(HashMismatchError)
    expect(await blobState(wrong)).toBeUndefined()
    expect(await operations(wrong)).toMatchObject([{ state: 'failed' }])
    expect(await store.exists(blobKey(wrong, 'jpg'))).toBe(false)
    expect(await readdir(store.incomingDir)).toEqual([])
  })
})

describe('restart between file steps', () => {
  async function interrupted(
    state: 'intent' | 'started' | 'fs_done',
    bytes: string,
    onDisk: boolean,
  ) {
    const file = await tempFile(bytes)
    const key = blobKey(file.sha256, 'mp4')
    if (onDisk) {
      await store.put(file.path, { sha256: file.sha256, ext: 'mp4' })
    }
    await db.execute(sql`
      INSERT INTO storage_operations (kind, blob_sha256, to_key, state, owner, started_at)
      VALUES ('put', ${shaBytes(file.sha256)}, ${key}, ${state}, 'worker-video:old:7',
              CASE WHEN ${state} <> 'intent' THEN now() END)`)
    return file.sha256
  }

  it('settles every unfinished operation of the role against the disk', async () => {
    const placed = await interrupted('fs_done', 'renamed before the crash', true)
    const half = await interrupted('started', 'crashed before the rename', false)
    const intent = await interrupted('intent', 'never started', false)
    const other = await interrupted('started', 'another role', false)
    await db.execute(
      sql`UPDATE storage_operations SET owner = 'worker:old:1' WHERE blob_sha256 = ${shaBytes(other)}`,
    )

    const report = await reconcileStorage(db, store, 'worker-video:')
    expect(report).toEqual({ cancelled: 1, committed: 1, failed: 1 })
    expect(await blobState(placed)).toBe('present')
    expect((await operations(placed))[0]?.state).toBe('committed')
    expect(await blobState(half)).toBeUndefined()
    expect((await operations(half))[0]?.state).toBe('failed')
    expect((await operations(intent))[0]?.state).toBe('cancelled')
    expect((await operations(other))[0]?.state, 'another role settles its own').toBe('started')
  })
})

describe('owner purge', () => {
  async function present(bytes: string, kind: 'video' | 'image' = 'video') {
    const file = await tempFile(bytes)
    await registerBlob(db, store, {
      file: file.path,
      sha256: file.sha256,
      ext: kind === 'video' ? 'mp4' : 'jpg',
      mediaKind: kind,
      owner: OWNER_ID,
    })
    return file.sha256
  }

  it('removes an unreferenced blob with its derivatives; the row stays purged', async () => {
    const sha = await present('nobody needs these')
    const generation = await createGeneration(db, {
      kind: 'thumb320',
      recipeDigest: 'r',
      metaStripped: false,
      masterSha256: shaBytes(sha),
      inputKind: 'master',
      inputSha256: shaBytes(sha),
      workId: null,
    })
    const thumb = join(store.derivedTmpDir, 'thumb-320.webp')
    await store.place((await tempFile('thumb')).path, `derived/gen/${generation}/thumb-320.webp`)
    await systemTx(db, (tx) =>
      finishGenerations(
        tx,
        [
          {
            generationId: generation,
            key: `derived/gen/${generation}/thumb-320.webp`,
            artifact: {
              kind: 'thumb320',
              name: 'thumb-320.webp',
              path: thumb,
              sha256: Buffer.alloc(32, 1).toString('hex'),
              bytes: 5,
              mime: 'image/webp',
              width: 320,
              height: 180,
              durationMs: null,
              frameMs: null,
            },
          },
        ],
        [generation],
      ),
    )
    const key = blobKey(sha, 'mp4')

    expect(await purgeBlob(db, store, sha, 'owner:cli')).toBe('purged')
    expect(await store.exists(key)).toBe(false)
    expect(await store.exists(`derived/gen/${generation}/thumb-320.webp`)).toBe(false)
    expect(await blobState(sha)).toBe('purged')
    expect((await operations(sha)).map((op) => [op.kind, op.state])).toEqual([
      ['put', 'committed'],
      ['purge', 'committed'],
    ])
    const { rows } = await db.execute<{ state: string }>(
      sql`SELECT state FROM rendition_generations WHERE id = ${generation}::uuid`,
    )
    expect(rows[0]?.state).toBe('evicted')

    // The bytes can come back: the same put returns the row to present.
    const again = await tempFile('nobody needs these')
    await registerBlob(db, store, {
      file: again.path,
      sha256: sha,
      ext: 'mp4',
      mediaKind: 'video',
      owner: OWNER_ID,
    })
    expect(await blobState(sha)).toBe('present')
  })

  it('keeps a blob a version holds', async () => {
    const sha = await present('a master of PPV-901')
    await seedItem(db, {
      model: lora,
      type: 'PPV',
      number: 901,
      files: [{ role: 'master', mediaKind: 'video', master: sha }],
    })
    expect(await purgeBlob(db, store, sha, 'owner:cli')).toBe('referenced')
    expect(await store.exists(blobKey(sha, 'mp4'))).toBe(true)
    expect(await blobState(sha)).toBe('present')
  })

  it('checks the references again after the file step', async () => {
    const sha = await present('referenced while being removed')
    const outcome = await purgeBlob(db, store, sha, 'owner:cli', {
      afterFiles: async () => {
        await seedItem(db, {
          model: lora,
          type: 'PPV',
          number: 902,
          files: [{ role: 'master', mediaKind: 'video', master: sha }],
        })
      },
    })
    expect(outcome).toBe('referenced')
    expect(await blobState(sha), 'the bytes are gone: the row says so').toBe('missing')
    expect((await operations(sha)).at(-1)).toMatchObject({ kind: 'purge', state: 'failed' })
  })

  it('a missing blob comes back by the same put', async () => {
    const sha = await present('lost then found', 'image')
    await db.execute(sql`UPDATE blobs SET state = 'missing' WHERE sha256 = ${shaBytes(sha)}`)
    const path = store.path(blobKey(sha, 'jpg'))
    await writeFile(path, 'damaged')
    expect((await stat(path)).size).toBe(7)
    await store.delete(blobKey(sha, 'jpg'))
    const file = await tempFile('lost then found')
    await registerBlob(db, store, {
      file: file.path,
      sha256: sha,
      ext: 'jpg',
      mediaKind: 'image',
      owner: OWNER_ID,
    })
    expect(await blobState(sha)).toBe('present')
  })

  it('keeps live master renditions built from a purged raw input while evicting unattached ones', async () => {
    const rawSha = await present('raw web upload video')
    const masterSha = await present('compressed av1 master video')
    await seedItem(db, {
      model: lora,
      type: 'CUS',
      number: 903,
      files: [{ role: 'master', mediaKind: 'video', master: masterSha }],
    })
    const liveGen = await createGeneration(db, {
      kind: 'thumb640',
      recipeDigest: 'r-live',
      metaStripped: false,
      masterSha256: shaBytes(masterSha),
      inputKind: 'source',
      inputSha256: shaBytes(rawSha),
      workId: null,
    })
    const orphanGen = await createGeneration(db, {
      kind: 'thumb320',
      recipeDigest: 'r-orphan',
      metaStripped: false,
      masterSha256: null,
      inputKind: 'source',
      inputSha256: shaBytes(rawSha),
      workId: null,
    })
    const putArt = async (genId: string, name: string) => {
      const key = `derived/gen/${genId}/${name}`
      await store.place((await tempFile(name)).path, key)
      await systemTx(db, (tx) =>
        finishGenerations(
          tx,
          [
            {
              generationId: genId,
              key,
              artifact: {
                kind: name.includes('640') ? 'thumb640' : 'thumb320',
                name,
                path: store.path(key),
                sha256: Buffer.alloc(32, 2).toString('hex'),
                bytes: 5,
                mime: 'image/webp',
                width: 640,
                height: 360,
                durationMs: null,
                frameMs: null,
              },
            },
          ],
          [genId],
        ),
      )
      return key
    }
    const liveKey = await putArt(liveGen, 'thumb-640.webp')
    const orphanKey = await putArt(orphanGen, 'thumb-320.webp')

    expect(await purgeBlob(db, store, rawSha, 'owner:cli')).toBe('purged')
    // Live master's rendition built from rawSha stays ready and on disk!
    expect(await store.exists(liveKey)).toBe(true)
    expect(await store.exists(orphanKey)).toBe(false)
    const { rows } = await db.execute<{ id: string; state: string; is_active: boolean }>(sql`
      SELECT id, state, is_active FROM rendition_generations
       WHERE id IN (${liveGen}::uuid, ${orphanGen}::uuid)`)
    expect(rows.find((r) => r.id === liveGen)).toMatchObject({ state: 'ready', is_active: true })
    expect(rows.find((r) => r.id === orphanGen)).toMatchObject({
      state: 'evicted',
      is_active: false,
    })
  })

  it('reconcileStorage settles interrupted purges safely (re-checking references and renditions)', async () => {
    const goneFree = await present('interrupted purge unreferenced')
    const masterSha = await present('live master for interrupted purge')
    await seedItem(db, {
      model: lora,
      type: 'CUS',
      number: 904,
      files: [{ role: 'master', mediaKind: 'video', master: masterSha }],
    })
    const liveGen = await createGeneration(db, {
      kind: 'poster',
      recipeDigest: 'r-p',
      metaStripped: false,
      masterSha256: shaBytes(masterSha),
      inputKind: 'source',
      inputSha256: shaBytes(goneFree),
      workId: null,
    })
    const ownGen = await createGeneration(db, {
      kind: 'poster',
      recipeDigest: 'r-own',
      metaStripped: false,
      masterSha256: shaBytes(goneFree),
      inputKind: 'master',
      inputSha256: shaBytes(goneFree),
      workId: null,
    })
    await db.execute(sql`
      UPDATE rendition_generations SET state = 'ready', is_active = true, ready_at = now()
       WHERE id IN (${liveGen}::uuid, ${ownGen}::uuid)`)
    await store.delete(blobKey(goneFree, 'mp4'))
    await db.execute(sql`
      INSERT INTO storage_operations (kind, blob_sha256, from_key, state, owner, started_at)
      VALUES ('purge', ${shaBytes(goneFree)}, ${blobKey(goneFree, 'mp4')}, 'fs_done', 'owner:old:1', now())`)

    // Referenced again before reconcile: must become `missing` and `failed`, never `purged`.
    const goneRef = await present('interrupted purge referenced')
    await seedItem(db, {
      model: lora,
      type: 'PPV',
      number: 905,
      files: [{ role: 'master', mediaKind: 'video', master: goneRef }],
    })
    await store.delete(blobKey(goneRef, 'mp4'))
    await db.execute(sql`
      INSERT INTO storage_operations (kind, blob_sha256, from_key, state, owner, started_at)
      VALUES ('purge', ${shaBytes(goneRef)}, ${blobKey(goneRef, 'mp4')}, 'fs_done', 'owner:old:2', now())`)

    const report = await reconcileStorage(db, store, 'owner:')
    expect(report).toEqual({ cancelled: 0, committed: 1, failed: 1 })
    expect(await blobState(goneFree)).toBe('purged')
    expect(await blobState(goneRef)).toBe('missing')
    const { rows: gens } = await db.execute<{ id: string; state: string }>(sql`
      SELECT id, state FROM rendition_generations WHERE id IN (${liveGen}::uuid, ${ownGen}::uuid)`)
    expect(gens.find((g) => g.id === liveGen)?.state).toBe('ready')
    expect(gens.find((g) => g.id === ownGen)?.state).toBe('evicted')
  })

  it('sweepIncoming removes stale partial files older than a day while keeping fresh ones', async () => {
    await mkdir(store.incomingDir, { recursive: true })
    const oldPartial = join(store.incomingDir, '.master-deadbeef0001.partial.mp4')
    const freshPartial = join(store.incomingDir, '.master-deadbeef0002.partial.mp4')
    await writeFile(oldPartial, 'abandoned encode')
    await writeFile(freshPartial, 'live encode')
    const now = Date.now()
    const dayAgo = (now - 25 * 60 * 60 * 1000) / 1000
    await utimes(oldPartial, dayAgo, dayAgo)
    expect(await sweepIncoming(db, store, now)).toEqual(['.master-deadbeef0001.partial.mp4'])
    expect(await readdir(store.incomingDir)).toEqual(['.master-deadbeef0002.partial.mp4'])
  })
})
