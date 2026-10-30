import type { Db, WorkHandler } from '@contentops/db'
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

export interface VerifyReport {
  checked: number
  ok: number
  bytes_checked: number
  missing: string[]
  corrupt: string[]
  /** Files on disk with no `blobs` row (an interrupted put, a hand-made copy). */
  orphans: string[]
  unreferenced: { sha256: string; key: string; bytes: number }[]
  unreferenced_bytes: number
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
    }>(sql`
      SELECT sha256, storage_key, byte_size FROM blobs
       WHERE state = 'present' AND NOT blob_is_referenced(sha256)
       ORDER BY registered_at`)
    report.unreferenced = unreferenced.map((row) => ({
      sha256: shaHex(row.sha256),
      key: row.storage_key,
      bytes: Number(row.byte_size),
    }))
    report.unreferenced_bytes = report.unreferenced.reduce((sum, b) => sum + b.bytes, 0)
    return { report }
  }
}

/** Puts a new `verify_blobs` run (system-wide, no model). */
export async function enqueueVerifyBlobs(db: Db): Promise<EnqueueResult> {
  return enqueueWork(db, {
    modelId: null,
    kind: 'verify_blobs',
    workKey: `verify:${new Date().toISOString()}`,
    streamKey: 'verify_blobs',
    priority: -100,
  })
}
