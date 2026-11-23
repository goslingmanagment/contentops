import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { enqueueWork, WorkRunner } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { intakeMediaHandlers } from './intake/media'
import { readNotContent } from './legacy/inputs'
import { createMediaEnv } from './media/pipeline'
import { shaBytes } from './media/storage'
import { modelId, systemTx, tempStore } from './media/testing'
import { opsPolicy } from './ops-owner'
import { type TestServer, testServer } from './testing/server'

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))

describe('CLI stdout flushing (no process.exit truncation)', () => {
  it('ops-cli, smoke/run and scripts/upload use process.exitCode instead of process.exit', async () => {
    for (const rel of ['ops-cli.ts', 'smoke/run.ts', '../scripts/upload.ts']) {
      const source = await readFile(join(SRC_DIR, rel), 'utf8')
      expect(source, rel).not.toMatch(/\bprocess\.exit\s*\(/)
    }
  })

  it('delivers >300 KB JSON through a slow pipe without truncation when using process.exitCode', async () => {
    const script = `
      const payload = JSON.stringify({ rows: Array.from({ length: 6000 }, (_, i) => ({ i, v: 'x'.repeat(48) })) }) + '\\n';
      Promise.resolve().then(() => {
        process.stdout.write(payload);
        process.exitCode = 0;
      });
    `
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      // Simulate a slow consumer pipe (like docker compose exec -T ... > file).
      child.stdout.pause()
      setTimeout(() => child.stdout.resume(), 5)
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    expect(code).toBe(0)
    const text = Buffer.concat(chunks).toString('utf8')
    expect(text.length).toBeGreaterThan(300_000)
    const parsed = JSON.parse(text) as { rows: unknown[] }
    expect(parsed.rows).toHaveLength(6000)
  })
})

describe('photo failure handling and source-scoped legacy.not_content policy', () => {
  let server: TestServer
  let lora: string

  beforeAll(async () => {
    server = await testServer()
    lora = await modelId(server.db, 'lora')
  })
  afterAll(() => server.close())

  it('derivePhotoForDraft blocks the draft as master_failed on permanent unreadable photo', async () => {
    const store = await tempStore('bad-photo')
    const env = await createMediaEnv({
      db: server.db,
      store,
      lp: 4,
      owner: 'worker-image:test',
      log: () => {},
      versions: {
        ffmpeg: 'n8.1.2-test',
        ffprobe: 'n8.1.2-test',
        svtav1: 'v4.2.0-test',
        libvips: '8.16.1',
        sharp: '0.34.2',
        libheif: null,
        libde265: null,
        libwebp: null,
        phash: 'sharp-phash@2.2.0',
      },
    })
    const badBytes = Buffer.from('not a real jpeg file at all')
    const shaHex = createHash('sha256').update(badBytes).digest('hex')
    await mkdir(store.stagingDir, { recursive: true })
    await writeFile(join(store.stagingDir, `${shaHex}.jpg`), badBytes)

    const draftId = await systemTx(server.db, async (tx) => {
      const { rows: src } = await tx.execute<{ id: string }>(sql`
        INSERT INTO sources (model_id, kind, label, read_only, enabled)
        VALUES (${lora}::uuid, 'web_upload', 'Bad Photo Test', false, true)
        RETURNING id`)
      const { rows: obj } = await tx.execute<{ id: string }>(sql`
        INSERT INTO source_objects (model_id, source_id, resource_id, current_path, current_name)
        VALUES (${lora}::uuid, ${src[0]?.id}::uuid, 'bad-photo-obj', '/6. Life/corrupt.jpg', 'corrupt.jpg')
        RETURNING id`)
      const { rows: rev } = await tx.execute<{ id: string }>(sql`
        INSERT INTO source_revisions (model_id, source_object_id, sequence_no, byte_size)
        VALUES (${lora}::uuid, ${obj[0]?.id}::uuid, 1, ${badBytes.length})
        RETURNING id`)
      const { rows: grp } = await tx.execute<{ id: string }>(sql`
        INSERT INTO inbox_groups (model_id, source_id, group_key, grouping, evidence)
        VALUES (${lora}::uuid, ${src[0]?.id}::uuid, ${`bad-photo:${randomUUID()}`}, 'single', '{}'::jsonb)
        RETURNING id`)
      const { rows: dr } = await tx.execute<{ id: string }>(sql`
        INSERT INTO inbox_drafts (model_id, group_id, source_revision_id, origin, state, byte_size, path, source_sha256)
        VALUES (${lora}::uuid, ${grp[0]?.id}::uuid, ${rev[0]?.id}::uuid, 'disk_scan', 'processing', ${badBytes.length},
                '/6. Life/corrupt.jpg', ${shaBytes(shaHex)})
        RETURNING id`)
      const id = dr[0]?.id as string
      await enqueueWork(tx, {
        modelId: lora,
        kind: 'derive_image',
        workKey: `derive:${shaHex}:${id}`,
        inputSha256: shaBytes(shaHex),
        draftId: id,
        priority: 10,
      })
      return id
    })

    const runner = new WorkRunner({
      db: server.db,
      role: 'worker-image',
      handlers: intakeMediaHandlers('worker-image', env),
      pollMs: 20,
      maxAttempts: 5,
    })
    runner.start()
    await vi.waitFor(
      async () => {
        const { rows } = await server.db.execute<{
          state: string
          failure_kind: string | null
          attempt_no: number
        }>(sql`
          SELECT state, failure_kind, attempt_no FROM work_operations
           WHERE draft_id = ${draftId}::uuid AND kind = 'derive_image'`)
        if (rows[0]?.state !== 'failed') throw new Error(`work state: ${rows[0]?.state}`)
        expect(rows[0]).toMatchObject({
          state: 'failed',
          failure_kind: 'permanent',
          attempt_no: 1,
        })
      },
      { timeout: 10_000, interval: 20 },
    )
    await runner.stop()

    const { rows: draft } = await server.db.execute<{
      state: string
      blocked_reason: string | null
      error: string | null
    }>(sql`
      SELECT state, blocked_reason, error FROM inbox_drafts WHERE id = ${draftId}::uuid`)
    expect(draft[0]).toMatchObject({
      state: 'processing',
      blocked_reason: 'master_failed',
      error: 'photo: unreadable',
    })
  })

  it('opsPolicy accepts source-scoped legacy.not_content.<sourceKind> and readNotContent merges them', async () => {
    await opsPolicy(server.db, {
      key: 'legacy.not_content',
      value: JSON.stringify({ paths: ['_common'] }),
      model: 'lora',
    })
    await opsPolicy(server.db, {
      key: 'legacy.not_content.yandex_disk',
      value: JSON.stringify({ paths: ['_ydisk-test'] }),
      model: 'lora',
    })
    expect((await readNotContent(server.db, lora, 'yandex_disk')).sort()).toEqual([
      '_common',
      '_ydisk-test',
    ])
    expect(await readNotContent(server.db, lora, 'dropbox')).toEqual(['_common'])
  })
})
