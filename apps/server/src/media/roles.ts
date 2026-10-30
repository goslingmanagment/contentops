import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Db, values, WorkHandler } from '@contentops/db'
import { configureImagePool } from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { MediaEnv } from './pipeline'
import type { BlobStore } from './storage'
import { renderCompatHandler, renderHandler, uniqRenderHandler } from './work/copies'
import { deriveImageHandler, deriveVideoHandler } from './work/derive'
import { exportHandler } from './work/export'
import { extractFrameHandler } from './work/frame'
import { encodeMasterHandler } from './work/master'
import { verifyBlobsHandler } from './work/verify-blobs'

type WorkRole = values.WorkRole
type WorkKind = values.WorkKind
type WorkSlot = values.WorkSlot

/** Handlers of the media pipeline by role (schema §3.4: each kind belongs to one role). */
export function mediaHandlers(
  role: WorkRole,
  env: MediaEnv,
): Partial<Record<WorkKind, WorkHandler>> {
  switch (role) {
    case 'worker-video':
      return {
        derive_video: deriveVideoHandler(env),
        encode_master: encodeMasterHandler(env),
        render: renderHandler(env),
        uniq_render: uniqRenderHandler(env),
        render_compat: renderCompatHandler(env),
        extract_frame: extractFrameHandler(env),
      }
    case 'worker-image':
      return { derive_image: deriveImageHandler(env) }
    case 'worker':
      return {
        verify_blobs: verifyBlobsHandler({ db: env.db, store: env.store }),
        export: exportHandler(env),
      }
  }
}

/** Encodes running right now under a live lease. */
async function runningEncodes(db: Db): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM work_operations
     WHERE kind = 'encode_master' AND state = 'running' AND lease_until > now()`)
  return rows[0]?.n ?? 0
}

/**
 * SPEC §12.0: photo batches slow down while two AV1 encodes run — one photo at a time and
 * half the libvips threads; back to `IMAGE_JOBS` and `sharp.concurrency(4)` after.
 */
export function imageThrottle(imageJobs: number) {
  let slowed: boolean | null = null
  return async (db: Db): Promise<Partial<Record<WorkSlot, number>>> => {
    const slow = (await runningEncodes(db)) >= 2
    if (slow !== slowed) {
      configureImagePool({ concurrency: slow ? 2 : 4 })
      slowed = slow
    }
    return { image: slow ? 1 : imageJobs }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Issues with new bytes live a day in `TMP_ROOT/exports/<receipt>/` (SPEC §9.1); the
 * receipt keeps their hash and size. Runs in `worker` every hour.
 */
export async function sweepExports(
  store: BlobStore,
  now = Date.now(),
  maxAgeMs = DAY_MS,
): Promise<string[]> {
  const removed: string[] = []
  let names: string[]
  try {
    names = await readdir(store.exportsDir)
  } catch {
    return removed
  }
  for (const name of names) {
    const dir = join(store.exportsDir, name)
    const info = await stat(dir).catch(() => null)
    if (!info || now - info.mtimeMs < maxAgeMs) continue
    await rm(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** Starts the hourly sweep; returns the stop function. */
export function startExportSweep(store: BlobStore, log: MediaEnv['log']): () => void {
  const run = () =>
    sweepExports(store)
      .then((removed) => {
        if (removed.length > 0) log(`exports: removed ${removed.length} issues older than a day`)
      })
      .catch((error: unknown) => log('exports sweep failed', error))
  run()
  const timer = setInterval(run, 60 * 60 * 1000)
  return () => clearInterval(timer)
}
