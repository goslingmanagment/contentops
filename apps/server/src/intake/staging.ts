import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { BlobStore } from '../media/storage'
import { shaBytes } from '../media/storage'
import type { Services } from '../services'

/**
 * Staged sources of intake (`TMP_ROOT/staging/<sha256>.<ext>`, SPEC §9.1): `fetch` and the web
 * upload leave the checked bytes there for the media works. Once the master is registered
 * (a photo's source is moved into `blobs/` by `derive_image`) and no media work of those bytes
 * is unfinished, the staged file is removed: after the master check, never before.
 */

/** Whether intake still needs the staged bytes of `sha`; `null` — not intake's bytes. */
async function stillNeeded(db: Db, sha: string): Promise<boolean | null> {
  const bytes = shaBytes(sha)
  const { rows } = await db.execute<{ drafts: number; waiting: number; works: number }>(sql`
    SELECT
      (SELECT count(*)::int FROM inbox_drafts WHERE source_sha256 = ${bytes}) AS drafts,
      (SELECT count(*)::int FROM inbox_drafts
        WHERE source_sha256 = ${bytes} AND state <> 'resolved'
          AND (master_verified_at IS NULL OR master_sha256 IS NULL)) AS waiting,
      (SELECT count(*)::int FROM work_operations
        WHERE input_sha256 = ${bytes} AND state IN ('pending', 'running', 'retry_wait')) AS works`)
  const row = rows[0]
  if (!row || row.drafts === 0) return null
  return row.waiting > 0 || row.works > 0
}

/** Removes the staged sources intake no longer needs; returns their hashes. */
export async function sweepStaging(db: Db, store: BlobStore): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(store.stagingDir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const sha = name.split('.')[0] ?? ''
    if (!/^[0-9a-f]{64}$/.test(sha)) continue
    if ((await stillNeeded(db, sha)) !== false) continue
    await rm(join(store.stagingDir, name), { force: true })
    removed.push(sha)
  }
  return removed
}

/** Every 5 minutes in `worker`; returns the stop function. */
export function startStagingSweep(
  db: Db,
  store: BlobStore,
  log: (line: string, error?: unknown) => void,
): () => void {
  const run = () =>
    sweepStaging(db, store)
      .then((removed) => {
        if (removed.length > 0) log(`staging: removed ${removed.length} sources with a master`)
      })
      .catch((error: unknown) => log('staging sweep failed', error))
  run()
  const timer = setInterval(run, 5 * 60 * 1000)
  return () => clearInterval(timer)
}

/** Right after an accept: the group's staged sources go at once when nothing needs them. */
export async function dropStagedOfGroup(services: Services, modelId: string, groupId: string) {
  const { rows } = await services.db.execute<{ sha: string }>(sql`
    SELECT DISTINCT encode(source_sha256, 'hex') AS sha FROM inbox_drafts
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND source_sha256 IS NOT NULL`)
  for (const { sha } of rows) {
    if ((await stillNeeded(services.db, sha)) !== false) continue
    const staged = await services.store.staged(sha).catch(() => null)
    if (staged) await rm(staged.path, { force: true }).catch(() => {})
  }
}
