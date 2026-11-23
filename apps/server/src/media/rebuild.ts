import type { Db } from '@contentops/db'
import { VIDEO_DERIVATIVE_KINDS } from '@contentops/media'
import { sql } from 'drizzle-orm'
import { currentPipelineVersion, type MediaEnv } from './pipeline'

/**
 * The background rebuild of video renditions after a recipe change (SPEC §9.1 «правка рецепта
 * … фоном пересобирает только этот вид»): a master whose active preview, poster, thumbnail or
 * annotation frames are of a recipe that no longer applies to it gets one `derive_video` on its
 * bytes. The work builds only the stale kinds (`planKinds`); the old generation is served until
 * the new one is ready, then the collector removes it.
 *
 * Which recipe applies: HDR by the ffprobe row of the master (`blob_probes.is_hdr`), as for the
 * platform copy (`platformDigest`); a master never probed counts as SDR.
 *
 * Bounded: at most `REBUILD_BATCH` rebuilds are unfinished at a time, below intake (10) and every
 * ordinary work (0), so a newly arrived file goes first. `worker-video` tops the batch up on start
 * and then every `REBUILD_EVERY_MS` until nothing is stale. One work per master and pipeline
 * version (`rebuild:<version>:<sha>`): a restart puts nothing twice, a failed one is not retried
 * in the same version, and bytes with an unfinished `derive_video` (intake) are left to it.
 */

/** Below intake and the copies, above the prints (−10). */
export const REBUILD_PRIORITY = -5
export const REBUILD_BATCH = 200
/** A minute: adopted previews (`work/derive.ts`) finish in seconds, the batch must not wait for them. */
export const REBUILD_EVERY_MS = 60 * 1000

export function rebuildKey(pipelineVersion: string, masterHex: string): string {
  return `rebuild:${pipelineVersion}:${masterHex}`
}

/** Puts the rebuilds of stale masters up to the batch; returns how many it put. */
export async function enqueueRebuilds(
  db: Db,
  env: Pick<MediaEnv, 'pipelineVersion' | 'recipes'>,
  batch = REBUILD_BATCH,
): Promise<number> {
  // Only the current image rebuilds: an older process left running never undoes a newer recipe.
  if ((await currentPipelineVersion(db)) !== env.pipelineVersion) return 0
  const wanted = sql.join(
    VIDEO_DERIVATIVE_KINDS.map(
      (kind) =>
        sql`(${kind}, ${env.recipes.video[kind].digest}, ${env.recipes.videoHdr[kind].digest})`,
    ),
    sql`, `,
  )
  const prefix = `rebuild:${env.pipelineVersion}:`
  const { rowCount } = await db.execute(sql`
    WITH wanted (kind, sdr, hdr) AS (VALUES ${wanted}),
    open AS (
      SELECT count(*)::int AS n FROM work_operations
       WHERE kind = 'derive_video' AND work_key LIKE 'rebuild:%'
         AND state IN ('pending', 'running', 'retry_wait')),
    stale AS (
      SELECT b.sha256, b.registered_at FROM blobs b
       WHERE b.state = 'present' AND b.media_kind = 'video'
         AND EXISTS (
           SELECT 1 FROM wanted w
            CROSS JOIN LATERAL (
              SELECT CASE WHEN EXISTS (
                SELECT 1 FROM blob_probes p
                 WHERE p.sha256 = b.sha256 AND p.kind = 'ffprobe' AND p.is_hdr
              ) THEN w.hdr ELSE w.sdr END AS digest
            ) applies
            WHERE NOT EXISTS (
                    SELECT 1 FROM rendition_generations g
                     WHERE g.master_sha256 = b.sha256 AND g.kind = w.kind
                       AND g.recipe_digest = applies.digest
                       AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped))
         AND NOT EXISTS (
           SELECT 1 FROM work_operations o
            WHERE o.kind = 'derive_video'
              AND (o.work_key = ${prefix} || encode(b.sha256, 'hex')
                   OR (o.state IN ('pending', 'running', 'retry_wait')
                       AND (o.input_sha256 = b.sha256
                            OR o.input_sha256 IN (
                              SELECT d.source_sha256 FROM inbox_drafts d
                               WHERE d.master_sha256 = b.sha256 AND d.source_sha256 IS NOT NULL
                              UNION
                              SELECT v.source_sha256 FROM asset_versions v
                               WHERE v.master_sha256 = b.sha256 AND v.source_sha256 IS NOT NULL
                            ))))))
    INSERT INTO work_operations (
      model_id, kind, work_key, priority, input_sha256, pipeline_version
    )
    SELECT owner.model_id, 'derive_video', ${prefix} || encode(s.sha256, 'hex'),
           ${REBUILD_PRIORITY}, s.sha256, ${env.pipelineVersion}
      FROM stale s
      JOIN LATERAL (
        SELECT v.model_id FROM asset_versions v WHERE v.master_sha256 = s.sha256
        UNION
        SELECT d.model_id FROM inbox_drafts d
         WHERE d.master_sha256 = s.sha256 AND d.master_verified_at IS NOT NULL
         ORDER BY 1 LIMIT 1
      ) owner ON true
     ORDER BY s.registered_at DESC
     LIMIT greatest(0, ${batch} - (SELECT n FROM open))
    ON CONFLICT DO NOTHING`)
  return rowCount ?? 0
}

/** Starts the rebuild of `worker-video`: now, then every minute; returns the stop function. */
export function startRenditionRebuild(
  db: Db,
  env: Pick<MediaEnv, 'pipelineVersion' | 'recipes'>,
  log: MediaEnv['log'],
  everyMs = REBUILD_EVERY_MS,
): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    enqueueRebuilds(db, env)
      .then((queued) => {
        if (queued > 0) log(`renditions: ${queued} rebuilds queued by the current recipes`)
      })
      .catch((error: unknown) => log('rendition rebuild failed', error))
      .finally(() => {
        running = false
      })
  }
  run()
  const timer = setInterval(run, everyMs)
  return () => clearInterval(timer)
}
