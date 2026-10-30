import type { Tx, values, WorkContext, WorkHandler } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { autoAcceptForDraft } from '../legacy/auto-accept'
import type { MediaEnv } from '../media/pipeline'
import { bindGenerations } from '../media/renditions'
import { mimeOfExt, shaHex } from '../media/storage'
import { registerBlob } from '../media/storage-ops'
import { inputSha } from '../media/work/common'
import { deriveImageHandler } from '../media/work/derive'
import { encodeMasterHandler } from '../media/work/master'

/**
 * The media works of a draft (SPEC §6.1 steps 2–3) with what intake adds to them: a draft
 * whose master is verified becomes «готово». A video's master comes from `encode_master`
 * (it writes the draft's master fields itself); a photo is its own master once it has been
 * decoded whole by `derive_image` (SPEC §9.2: no re-encoding), so the staged source is
 * registered as a blob and becomes the master of the draft.
 */

async function markReady(tx: Tx, ctx: WorkContext): Promise<void> {
  if (!ctx.work.draftId || !ctx.work.modelId) return
  const { rowCount } = await tx.execute(sql`
    UPDATE inbox_drafts
       SET state = 'ready', ready_at = now(), updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${ctx.work.modelId}::uuid AND id = ${ctx.work.draftId}::uuid
       AND state IN ('discovered', 'processing') AND master_verified_at IS NOT NULL`)
  if (!rowCount) return
  // The old corpus accepts itself when nothing is in dispute (SPEC §6.3, DESIGN §4.9); a
  // failure there never undoes the media work — the group just stays in its queue.
  const modelId = ctx.work.modelId
  const draftId = ctx.work.draftId
  await tx.transaction((inner) => autoAcceptForDraft(inner, modelId, draftId)).catch(() => null)
}

function encodeMasterForDraft(env: MediaEnv): WorkHandler {
  const encode = encodeMasterHandler(env)
  return async (ctx) => {
    const result = (await encode(ctx)) ?? {}
    return {
      ...result,
      commit: async (tx) => {
        await result.commit?.(tx)
        await markReady(tx, ctx)
      },
    }
  }
}

function derivePhotoForDraft(env: MediaEnv): WorkHandler {
  const derive = deriveImageHandler(env)
  return async (ctx) => {
    const result = (await derive(ctx)) ?? {}
    if (!ctx.work.draftId || !ctx.work.modelId) return result
    const sha = inputSha(ctx)
    const hex = shaHex(sha)
    const staged = await env.store.staged(hex)
    if (staged) {
      await registerBlob(env.db, env.store, {
        file: staged.path,
        sha256: hex,
        ext: staged.ext,
        mediaKind: 'image',
        mime: mimeOfExt(staged.ext),
        // The source is the master: an atomic rename into `blobs/`, no second copy (§9.1).
        move: true,
        owner: env.owner,
      })
    }
    return {
      ...result,
      commit: async (tx) => {
        await result.commit?.(tx)
        await tx.execute(sql`
          UPDATE inbox_drafts
             SET master_sha256 = ${sha}, source_blob_sha256 = ${sha}, master_is_source = true,
                 master_verified_at = coalesce(master_verified_at, now()),
                 updated_at = now(), row_version = row_version + 1
           WHERE model_id = ${ctx.work.modelId}::uuid AND id = ${ctx.work.draftId}::uuid
             AND state <> 'resolved'
             AND EXISTS (SELECT 1 FROM blobs WHERE sha256 = ${sha} AND state = 'present')`)
        // The photo is its own master from now on: its renditions are the master's. The inner
        // derive looked for a master before this update and found none.
        await bindGenerations(tx, sha, sha)
        await similarPhotos(tx, ctx.work.modelId as string, ctx.work.draftId as string, sha)
        await markReady(tx, ctx)
      },
    }
  }
}

/**
 * «Похоже на фото № 7 из сета 69 — сравнить» (SPEC §6.2): the current versions of accepted
 * photos of the model within the pHash distance `phash_suggest_threshold` become candidates
 * of the draft — a hint, never a merge. No threshold set — no hints (schema §9.2).
 */
async function similarPhotos(tx: Tx, modelId: string, draftId: string, sha: Buffer) {
  const { rows } = await tx.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = 'phash_suggest_threshold' AND account_id IS NULL AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${modelId}::uuid) AND value IS NOT NULL
     ORDER BY model_id NULLS LAST LIMIT 1`)
  const threshold = Number(rows[0]?.value)
  if (!Number.isFinite(threshold)) return
  await tx.execute(sql`
    INSERT INTO inbox_draft_candidates (model_id, draft_id, kind, item_id, version_id, score, signals)
    SELECT ${modelId}::uuid, ${draftId}::uuid, 'similar_photo', near.item_id, near.version_id,
           1 - near.distance / 64.0, jsonb_build_object('phash_distance', near.distance)
      FROM (
        SELECT DISTINCT ON (v.id) m.item_id, v.id AS version_id,
               bit_count(p.phash # mine.phash) AS distance
          FROM blob_phashes mine
          JOIN blob_phashes p ON p.algorithm = mine.algorithm AND p.algo_version = mine.algo_version
                             AND p.normalization = mine.normalization AND p.sha256 <> mine.sha256
          JOIN asset_versions v ON v.model_id = ${modelId}::uuid AND v.master_sha256 = p.sha256
          JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id AND a.current_version_id = v.id
          JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                                 AND m.kind = 'owned' AND m.removed_at IS NULL
         WHERE mine.sha256 = ${sha} AND bit_count(p.phash # mine.phash) <= ${threshold}
         ORDER BY v.id, distance
      ) near
     ORDER BY near.distance LIMIT 3
    ON CONFLICT DO NOTHING`)
}

/** Intake's versions of the media handlers of a role; the rest stay as the pipeline has them. */
export function intakeMediaHandlers(
  role: values.WorkRole,
  env: MediaEnv,
): Partial<Record<values.WorkKind, WorkHandler>> {
  switch (role) {
    case 'worker-video':
      return { encode_master: encodeMasterForDraft(env) }
    case 'worker-image':
      return { derive_image: derivePhotoForDraft(env) }
    default:
      return {}
  }
}
