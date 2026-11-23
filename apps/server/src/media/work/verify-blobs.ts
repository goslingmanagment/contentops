import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db, Queryable, WorkHandler } from '@contentops/db'
import { type EnqueueResult, enqueueWork } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { BlobStore } from '../storage'
import { sha256OfFile, shaHex } from '../storage'

/**
 * `verify-blobs` (SPEC §9.1, §11.2; schema §3.4 `report`): every present blob is hashed on
 * disk and compared with the database; files under `blobs/` without a row are listed; blobs
 * nobody references (`blob_is_referenced`) are listed for the owner's purge command, which
 * checks the references again under the row lock. Nothing is removed here.
 */

export type UnreferencedOrigin =
  | 'rejected_draft'
  | 'alias_draft'
  | 'released_web_upload'
  | 'orphan_blob'

export interface VerifyReport {
  checked: number
  ok: number
  bytes_checked: number
  missing: string[]
  corrupt: string[]
  /** Files on disk with no `blobs` row (an interrupted put, a hand-made copy). */
  orphans: string[]
  unreferenced: { sha256: string; key: string; bytes: number; origin?: UnreferencedOrigin }[]
  unreferenced_bytes: number
  unreferenced_by_origin?: Partial<Record<UnreferencedOrigin, { count: number; bytes: number }>>
  /** Raw bytes of registered web uploads kept until archived externally (`raw_released_at IS NULL`). */
  held_web_uploads?: { count: number; bytes: number }
  /**
   * Web uploads left behind (SPEC §9.1: «брошенную загрузку удаляет та же команда
   * владельца»): failed, cancelled, or still receiving with no activity for a day, with bytes on disk.
   */
  abandoned_uploads?: { model_id: string; upload_id: string; key: string; bytes: number }[]
}

export interface VerifyCheckpoint {
  /** Hex of the last blob hashed: a re-claimed run continues after it. */
  after: string | null
  partial: VerifyReport
}

const emptyReport = (): VerifyReport => ({
  checked: 0,
  ok: 0,
  bytes_checked: 0,
  missing: [],
  corrupt: [],
  orphans: [],
  unreferenced: [],
  unreferenced_bytes: 0,
})

const BATCH = 200

export function verifyBlobsHandler(deps: { db: Db; store: BlobStore }): WorkHandler {
  return async (ctx) => {
    const saved = ctx.work.checkpoint as VerifyCheckpoint | null
    const report = saved?.partial ?? emptyReport()
    let after = saved?.after ?? null
    const { rows: totals } = await deps.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM blobs WHERE state = 'present'`,
    )
    const total = totals[0]?.n ?? 0
    for (;;) {
      const { rows } = await deps.db.execute<{
        sha256: Buffer
        storage_key: string
        byte_size: string
      }>(sql`
        SELECT sha256, storage_key, byte_size FROM blobs
         WHERE state = 'present' ${after ? sql`AND sha256 > ${Buffer.from(after, 'hex')}` : sql``}
         ORDER BY sha256 LIMIT ${BATCH}`)
      if (rows.length === 0) break
      for (const row of rows) {
        ctx.signal.throwIfAborted()
        const hex = shaHex(row.sha256)
        const stat = await deps.store.stat(row.storage_key)
        let verdict: 'ok' | 'missing' | 'corrupt'
        if (!stat) verdict = 'missing'
        else if (stat.bytes !== Number(row.byte_size)) verdict = 'corrupt'
        else {
          const actual = await sha256OfFile(deps.store.path(row.storage_key), ctx.signal)
          verdict = actual === hex ? 'ok' : 'corrupt'
          report.bytes_checked += stat.bytes
        }
        report.checked++
        if (verdict === 'ok') {
          report.ok++
          await deps.db.execute(
            sql`UPDATE blobs SET verified_at = now() WHERE sha256 = ${row.sha256}`,
          )
        } else {
          report[verdict].push(hex)
          await deps.db.execute(
            sql`UPDATE blobs SET state = ${verdict} WHERE sha256 = ${row.sha256} AND state = 'present'`,
          )
        }
        after = hex
      }
      await ctx.checkpoint({
        checkpoint: { after, partial: report } satisfies VerifyCheckpoint,
        progress: {
          num: report.checked,
          den: Math.max(total, report.checked),
          note: 'хэши блобов',
        },
      })
    }

    // Files nobody registered, by a walk of the disk.
    const known = new Set<string>()
    const { rows: keys } = await deps.db.execute<{ storage_key: string }>(
      sql`SELECT storage_key FROM blobs`,
    )
    for (const { storage_key } of keys) known.add(storage_key)
    report.orphans = []
    for await (const file of deps.store.walkBlobs()) {
      if (!known.has(file.key)) report.orphans.push(file.key)
    }

    const { rows: unreferenced } = await deps.db.execute<{
      sha256: Buffer
      storage_key: string
      byte_size: string
      origin: UnreferencedOrigin
    }>(sql`
      SELECT b.sha256, b.storage_key, b.byte_size,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM web_uploads u
                  WHERE u.sha256 = b.sha256 AND u.state = 'registered'
                    AND u.raw_released_at IS NOT NULL
               ) THEN 'released_web_upload'
               WHEN EXISTS (
                 SELECT 1 FROM inbox_drafts d
                  WHERE (d.master_sha256 = b.sha256 OR d.source_blob_sha256 = b.sha256)
                    AND d.state = 'resolved' AND d.outcome = 'rejected'
               ) THEN 'rejected_draft'
               WHEN EXISTS (
                 SELECT 1 FROM inbox_drafts d
                  WHERE (d.master_sha256 = b.sha256 OR d.source_blob_sha256 = b.sha256)
                    AND d.state = 'resolved' AND d.outcome = 'alias'
               ) THEN 'alias_draft'
               ELSE 'orphan_blob'
             END AS origin
        FROM blobs b
       WHERE b.state = 'present' AND NOT blob_is_referenced(b.sha256)
       ORDER BY b.registered_at`)
    report.unreferenced = unreferenced.map((row) => ({
      sha256: shaHex(row.sha256),
      key: row.storage_key,
      bytes: Number(row.byte_size),
      origin: row.origin,
    }))
    report.unreferenced_bytes = report.unreferenced.reduce((sum, b) => sum + b.bytes, 0)
    const byOrigin: Partial<Record<UnreferencedOrigin, { count: number; bytes: number }>> = {}
    for (const item of report.unreferenced) {
      const origin = item.origin ?? 'orphan_blob'
      const entry = byOrigin[origin] ?? { count: 0, bytes: 0 }
      entry.count += 1
      entry.bytes += item.bytes
      byOrigin[origin] = entry
    }
    report.unreferenced_by_origin = byOrigin

    const { rows: heldRaw } = await deps.db.execute<{ count: number; bytes: string }>(sql`
      SELECT count(*)::int AS count, coalesce(sum(b.byte_size), 0)::text AS bytes
        FROM blobs b
       WHERE b.state = 'present'
         AND EXISTS (
           SELECT 1 FROM web_uploads u
            WHERE u.sha256 = b.sha256 AND u.state = 'registered' AND u.raw_released_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM inbox_drafts d
                 WHERE d.model_id = u.model_id AND d.web_upload_id = u.id
                   AND d.state = 'resolved' AND d.outcome IN ('rejected', 'alias')
              )
         )
         AND NOT EXISTS (SELECT 1 FROM asset_versions v WHERE v.master_sha256 = b.sha256)
         AND NOT EXISTS (
           SELECT 1 FROM inbox_drafts d
            WHERE (d.master_sha256 = b.sha256 OR d.source_blob_sha256 = b.sha256)
              AND d.state <> 'resolved'
         )`)
    report.held_web_uploads = {
      count: heldRaw[0]?.count ?? 0,
      bytes: Number(heldRaw[0]?.bytes ?? 0),
    }

    const { rows: uploads } = await deps.db.execute<{
      model_id: string
      upload_id: string
      state: string
      tmp_key: string
    }>(sql`
      SELECT model_id, upload_id, state, tmp_key FROM web_uploads
       WHERE sha256 IS NULL
         AND (state IN ('failed', 'abandoned')
              OR (state IN ('receiving', 'received') AND created_at < now() - interval '1 day'))
       ORDER BY created_at`)
    const staleCutoffMs = Date.now() - 24 * 60 * 60 * 1000
    report.abandoned_uploads = []
    for (const upload of uploads) {
      const info = await stat(join(deps.store.roots.dataRoot, upload.tmp_key)).catch(() => null)
      if (!info) continue
      // An upload still receiving chunks (fresh mtime) is not abandoned even if started >1d ago.
      if (
        (upload.state === 'receiving' || upload.state === 'received') &&
        info.mtimeMs >= staleCutoffMs
      ) {
        continue
      }
      report.abandoned_uploads.push({
        model_id: upload.model_id,
        upload_id: upload.upload_id,
        key: upload.tmp_key,
        bytes: info.size,
      })
    }
    return { report }
  }
}

/** Puts a new `verify_blobs` run (system-wide, no model). */
export async function enqueueVerifyBlobs(q: Queryable): Promise<EnqueueResult> {
  return enqueueWork(q, {
    modelId: null,
    kind: 'verify_blobs',
    workKey: `verify:${new Date().toISOString()}`,
    streamKey: 'verify_blobs',
    priority: -100,
  })
}
