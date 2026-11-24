import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { BlobStore } from '../media/storage'
import { shaBytes } from '../media/storage'
import { sweepIncoming } from '../media/storage-ops'
import { stagingState } from '../originals/hold'
import type { Services } from '../services'

/**
 * Staged sources of intake (`TMP_ROOT/staging/<sha256>.<ext>`, SPEC §9.1): `fetch` and the web
 * upload leave the checked bytes there for the media works. Once the master is registered
 * (a photo's source is moved into `blobs/` by `derive_image`) and no media work of those bytes
 * is unfinished, the staged file is removed: after the master check, never before — and, while
 * the originals hold it (`originals/hold.ts`: its copy to MEGA not written yet, at most 24 h and
 * 20 GB), after its original is reliable.
 */

export interface SweepResult {
  removed: string[]
  /** Staged sources the originals hold, and their bytes. */
  held: number
  heldBytes: number
}

async function sweep(db: Db, store: BlobStore, only?: ReadonlySet<string>): Promise<SweepResult> {
  const state = await stagingState(db, store)
  const removed: string[] = []
  for (const file of state.files) {
    if (file.verdict !== 'free' || (only && !only.has(file.sha))) continue
    for (const path of file.paths) await rm(path, { force: true })
    removed.push(file.sha)
  }
  const held = state.files.filter((file) => file.verdict === 'held').length
  return { removed, held, heldBytes: state.heldBytes }
}

/** Removes the staged sources nothing holds any more; returns their hashes. */
export async function sweepStaging(db: Db, store: BlobStore): Promise<string[]> {
  return (await sweep(db, store)).removed
}

const UNPACK_MIN_AGE_MS = 60 * 60 * 1000
const UNPACK_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Removes `TMP_ROOT/unpack/<sha256>/` directories once no `unpack_archive` is unfinished and
 * no archive revision with those bytes (verified or remote SHA-256) still has unbound members;
 * also cleans stale `.part-*` folders older than a day.
 */
export async function sweepUnpacked(
  db: Db,
  store: BlobStore,
  now = Date.now(),
  minAgeMs = UNPACK_MIN_AGE_MS,
): Promise<string[]> {
  const unpackRoot = join(store.roots.tmpRoot, 'unpack')
  let names: string[]
  try {
    names = await readdir(unpackRoot)
  } catch {
    return []
  }
  if (names.length === 0) return []
  const { rows: busy } = await db.execute<{ busy: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM work_operations
       WHERE kind = 'unpack_archive' AND state IN ('pending', 'running', 'retry_wait')
    ) AS busy`)
  if (busy[0]?.busy) return []

  const removed: string[] = []
  for (const name of names) {
    const dir = join(unpackRoot, name)
    const info = await stat(dir).catch(() => null)
    if (!info) continue
    if (name.includes('.part-')) {
      if (now - info.mtimeMs >= UNPACK_PART_MAX_AGE_MS) {
        await rm(dir, { recursive: true, force: true })
        removed.push(name)
      }
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(name)) continue
    if (now - info.mtimeMs < minAgeMs) continue
    const bytes = shaBytes(name)
    const { rows } = await db.execute<{ unpacked: boolean; unbound: boolean }>(sql`
      SELECT
        EXISTS (
          SELECT 1 FROM source_revisions ar WHERE ar.source_sha256 = ${bytes}
        ) AS unpacked,
        EXISTS (
          SELECT 1 FROM source_revisions ar
           WHERE (ar.source_sha256 = ${bytes} OR ar.remote_sha256 = ${bytes})
             AND EXISTS (
               SELECT 1 FROM source_objects mo
                 JOIN source_revisions mr
                   ON mr.model_id = mo.model_id AND mr.id = mo.current_revision_id
                WHERE mo.model_id = ar.model_id AND mo.archive_revision_id = ar.id
                  AND NOT mo.is_dir AND mr.source_sha256 IS NULL
             )
        ) AS unbound`)
    if (!rows[0]?.unpacked || rows[0].unbound) continue
    await rm(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** Every 5 minutes in `worker`; returns the stop function. */
export function startStagingSweep(
  db: Db,
  store: BlobStore,
  log: (line: string, error?: unknown) => void,
): () => void {
  const run = async () => {
    const { removed, held, heldBytes } = await sweep(db, store)
    if (removed.length > 0) log(`staging: removed ${removed.length} sources with a master`)
    if (held > 0) {
      log(`staging: ${held} sources (${heldBytes} bytes) held until their copies are checked`)
    }
    const unpacked = await sweepUnpacked(db, store)
    if (unpacked.length > 0) log(`unpack: removed ${unpacked.length} finished archives`)
    const incoming = await sweepIncoming(db, store)
    if (incoming.length > 0) log(`incoming: removed ${incoming.length} stale partial files`)
  }
  run().catch((error: unknown) => log('staging sweep failed', error))
  const timer = setInterval(
    () => run().catch((error: unknown) => log('staging sweep failed', error)),
    5 * 60 * 1000,
  )
  return () => clearInterval(timer)
}

/** Right after an accept: the group's staged sources go at once when nothing holds them. */
export async function dropStagedOfGroup(services: Services, modelId: string, groupId: string) {
  const { rows } = await services.db.execute<{ sha: string }>(sql`
    SELECT DISTINCT encode(source_sha256, 'hex') AS sha FROM inbox_drafts
     WHERE model_id = ${modelId}::uuid AND group_id = ${groupId}::uuid AND source_sha256 IS NOT NULL`)
  if (rows.length === 0) return
  await sweep(services.db, services.store, new Set(rows.map((row) => row.sha))).catch(() => {})
}
