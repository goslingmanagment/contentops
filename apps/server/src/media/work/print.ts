import type { Db, Queryable, Tx, WorkHandler } from '@contentops/db'
import { VIDEO_PRINT_PROFILE, type VideoPrint, videoPrint } from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { MediaEnv } from '../pipeline'
import { asWorkError, inputSha } from './common'

/**
 * Prints of videos (SPEC §6.2 «Похоже на ролик», `video_prints`): the duration of the picture
 * and the pHash of ten frames, taken from the ready `preview.mp4` of the bytes. Intake prints a
 * video in its first pass (`derive.ts`); `video_print` prints what was accepted before — a
 * light work of `worker-video` next to the copies, at the lowest priority, so the encoders
 * never wait for it.
 */

/** The print of these bytes by the current algorithm, if there is one. */
export async function storedPrint(
  q: Queryable,
  sha: Buffer,
  algoVersion: string,
): Promise<{ duration_ms: number; frames: string } | null> {
  const { rows } = await q.execute<{ duration_ms: number; frames: string }>(sql`
    SELECT duration_ms, frames::text AS frames FROM video_prints
     WHERE sha256 = ${sha} AND algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
       AND algo_version = ${algoVersion}`)
  return rows[0] ?? null
}

/** The file of the newest ready preview built from these bytes. */
async function previewFile(env: MediaEnv, sha: Buffer): Promise<string | null> {
  const { rows } = await env.db.execute<{ storage_key: string }>(sql`
    SELECT a.storage_key FROM rendition_generations g
      JOIN rendition_artifacts a ON a.generation_id = g.id AND a.name = 'preview.mp4'
                                AND a.state = 'ready'
     WHERE g.input_sha256 = ${sha} AND g.kind = 'preview' AND g.state = 'ready'
     ORDER BY g.ready_at DESC LIMIT 1`)
  const key = rows[0]?.storage_key
  return key && (await env.store.exists(key)) ? env.store.path(key) : null
}

/** The print of a preview file: ten seeks, the tools below the encoders (`nice`). */
export function printPreview(
  env: MediaEnv,
  file: string,
  signal?: AbortSignal,
): Promise<VideoPrint> {
  return videoPrint({
    input: file,
    workDir: env.store.derivedTmpDir,
    signal,
    niceness: Math.max(env.niceness ?? 0, 9),
    versions: env.versions,
  })
}

/** The print of the ready preview of `sha`; `null` — no preview to print from. */
export async function printOfBytes(
  env: MediaEnv,
  sha: Buffer,
  signal?: AbortSignal,
): Promise<VideoPrint | null> {
  const file = await previewFile(env, sha)
  return file ? printPreview(env, file, signal) : null
}

export async function savePrint(tx: Tx, sha: Buffer, print: VideoPrint): Promise<void> {
  await tx.execute(sql`
    INSERT INTO video_prints (sha256, algorithm, algo_version, duration_ms, frames)
    VALUES (${sha}, ${print.algorithm}, ${print.algoVersion}, ${print.durationMs},
            ${`{${print.frames.join(',')}}`}::bit(64)[])
    ON CONFLICT DO NOTHING`)
}

/**
 * `video_print`: the print of one video whose preview is ready. `extra` — what the caller adds
 * in the same transaction (intake: the hint of a draft with these bytes).
 */
export function videoPrintHandler(
  env: MediaEnv,
  extra?: (tx: Tx, sha: Buffer) => Promise<void>,
): WorkHandler {
  return async (ctx) => {
    const sha = inputSha(ctx)
    if (await storedPrint(env.db, sha, env.versions.phash)) {
      return {
        report: { cached: true },
        ...(extra ? { commit: (tx: Tx) => extra(tx, sha) } : {}),
      }
    }
    try {
      const print = await printOfBytes(env, sha, ctx.signal)
      // A video without a preview (its derive failed) has nothing to print; intake shows its ▲.
      if (!print) return { report: { printed: false, reason: 'no preview' } }
      return {
        report: { printed: true, duration_ms: print.durationMs, frames: print.frames.length },
        commit: async (tx) => {
          await savePrint(tx, sha, print)
          await extra?.(tx, sha)
        },
      }
    } catch (error) {
      throw asWorkError(error)
    }
  }
}

/** Below every other work but the storage check (`verify_blobs`, −100). */
export const PRINT_BACKFILL_PRIORITY = -10

/**
 * The prints of the library accepted before them (PLAN, stage 7): one `video_print` per video
 * with a ready preview and no print, per model that holds the bytes. Run by `worker-video` on
 * start and by `ops.js video-copies --yes`; a repeat finds the works already there.
 */
export async function enqueueVideoPrints(
  db: Db | Tx,
  algoVersion: string,
  modelId: string | null = null,
  /** A day for a repeat by hand: a print whose work failed gets a work of its own. */
  again: string | null = null,
): Promise<number> {
  const tail = again ? `:${again}` : ''
  const { rowCount } = await db.execute(sql`
    INSERT INTO work_operations (model_id, kind, work_key, priority, input_sha256)
    SELECT DISTINCT ON (owner.model_id, g.input_sha256)
           owner.model_id, 'video_print',
           'print:' || ${algoVersion} || ':' || encode(g.input_sha256, 'hex') || ${tail},
           ${PRINT_BACKFILL_PRIORITY}, g.input_sha256
      FROM rendition_generations g
      JOIN LATERAL (
        SELECT v.model_id FROM asset_versions v
         WHERE v.source_sha256 = g.input_sha256 OR v.master_sha256 = g.input_sha256
        UNION
        SELECT d.model_id FROM inbox_drafts d
         WHERE d.source_sha256 = g.input_sha256 AND d.state <> 'resolved'
      ) owner ON true
     WHERE g.kind = 'preview' AND g.state = 'ready'
       AND (${modelId}::uuid IS NULL OR owner.model_id = ${modelId}::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM video_prints p
          WHERE p.sha256 = g.input_sha256 AND p.algorithm = ${VIDEO_PRINT_PROFILE.algorithm}
            AND p.algo_version = ${algoVersion})
    ON CONFLICT DO NOTHING`)
  return rowCount ?? 0
}
