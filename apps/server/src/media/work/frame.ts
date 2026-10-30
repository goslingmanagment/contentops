import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueueWork, type Tx, WorkError, type WorkHandler } from '@contentops/db'
import { extractFrame } from '@contentops/media'
import { sql } from 'drizzle-orm'
import { locateInput, probeVideoCached } from '../inputs'
import type { MediaEnv } from '../pipeline'
import { shaBytes } from '../storage'
import { registerBlob } from '../storage-ops'
import { asWorkError, modelOf } from './common'

/**
 * `extract_frame` (schema §3.4, `COPY_JOBS` next to the encoders): a frame of a master in
 * full size becomes a photo of the same object — «Сделать фото» (`photo`) or «Сделать
 * обложкой» (`cover`, the new photo becomes the cover). A durable asset with `frame_from`
 * provenance; its thumbnails follow by `derive_image`.
 */

export type FramePurpose = 'photo' | 'cover'

/** `frame:<master version>:<ms>:<purpose>`. */
export function frameKey(versionId: string, atMs: number, purpose: FramePurpose): string {
  return `frame:${versionId}:${Math.round(atMs)}:${purpose}`
}

function parseFrameKey(workKey: string): { atMs: number; purpose: FramePurpose } {
  const [, , ms, purpose] = workKey.split(':')
  if (!ms || !/^\d+$/.test(ms) || (purpose !== 'photo' && purpose !== 'cover')) {
    throw new WorkError('permanent', 'bad_key', `bad frame key ${workKey}`)
  }
  return { atMs: Number(ms), purpose }
}

/** Role of a new photo in its object (naming §3): the cover of a PPV is its `thumb`. */
export function photoRole(itemType: string, purpose: FramePurpose): 'pic' | 'thumb' | null {
  if (purpose === 'cover' && itemType === 'PPV') return 'thumb'
  return ['PPV', 'SXT', 'CUS', 'LIFE', 'PRM'].includes(itemType) ? 'pic' : null
}

interface Owner extends Record<string, unknown> {
  item_id: string
  item_type: string
  master_sha256: Buffer
}

async function addPhoto(
  tx: Tx,
  model: string,
  owner: Owner,
  role: 'pic' | 'thumb',
  photo: { sha: Buffer; width: number; height: number },
  parentVersionId: string,
  params: Record<string, unknown>,
  workId: string,
): Promise<{ membershipId: string; versionId: string }> {
  const assetId = randomUUID()
  const versionId = randomUUID()
  const membershipId = randomUUID()
  await tx.execute(sql`
    INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id)
    VALUES (${model}::uuid, ${assetId}::uuid, ${owner.item_id}::uuid, 'image', ${versionId}::uuid)`)
  await tx.execute(sql`
    INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256, work_id, width, height)
    VALUES (${model}::uuid, ${versionId}::uuid, ${assetId}::uuid, 1, ${photo.sha}, ${workId}::uuid,
            ${photo.width}, ${photo.height})`)
  await tx.execute(sql`
    INSERT INTO item_memberships (model_id, id, item_id, item_type, asset_id, kind, role, ordinal,
                                  display_position)
    SELECT ${model}::uuid, ${membershipId}::uuid, ${owner.item_id}::uuid, ${owner.item_type},
           ${assetId}::uuid, 'owned', ${role},
           CASE WHEN ${role} = 'pic' THEN coalesce((
             SELECT max(ordinal) FROM item_memberships
              WHERE model_id = ${model}::uuid AND item_id = ${owner.item_id}::uuid AND role = 'pic'), 0) + 1 END,
           coalesce((SELECT max(display_position) FROM item_memberships
                      WHERE model_id = ${model}::uuid AND item_id = ${owner.item_id}::uuid), 0) + 1`)
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_version_id, parent_version_id, params, basis, work_id)
    VALUES (${model}::uuid, 'frame_from', ${versionId}::uuid, ${parentVersionId}::uuid,
            ${JSON.stringify(params)}::jsonb, 'extract_frame', ${workId}::uuid)`)
  return { membershipId, versionId }
}

export function extractFrameHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const model = modelOf(ctx)
    const { atMs, purpose } = parseFrameKey(ctx.work.workKey)
    const { rows } = await env.db.execute<Owner>(sql`
      SELECT m.item_id, m.item_type, v.master_sha256
        FROM asset_versions v
        JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                               AND m.kind = 'owned' AND m.removed_at IS NULL
       WHERE v.model_id = ${model}::uuid AND v.id = ${ctx.work.assetVersionId}::uuid`)
    const owner = rows[0]
    if (!owner) throw new WorkError('permanent', 'no_master', 'the master version is gone')
    const role = photoRole(owner.item_type, purpose)
    if (!role) throw new WorkError('permanent', 'role_not_fit', `${owner.item_type} has no photos`)
    const input = await locateInput(env, owner.master_sha256)
    const dir = join(env.store.incomingDir, `frame-${ctx.work.id}-${ctx.work.attemptNo}`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    try {
      const probe = await probeVideoCached(env, input, ctx.signal)
      const frame = await extractFrame({
        input: input.path,
        outDir: dir,
        atMs,
        probe,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
      })
      const blob = await registerBlob(env.db, env.store, {
        file: frame.file.path,
        sha256: frame.file.sha256,
        ext: 'jpg',
        mediaKind: 'image',
        mime: 'image/jpeg',
        move: true,
        owner: env.owner,
      })
      const sha = shaBytes(blob.sha256)
      return {
        outputSha256: sha,
        report: { at_ms: frame.atMs, purpose, sha256: blob.sha256 },
        commit: async (tx) => {
          const added = await addPhoto(
            tx,
            model,
            owner,
            role,
            { sha, width: frame.file.width, height: frame.file.height },
            ctx.work.assetVersionId as string,
            { t_ms: frame.atMs, recipe: frame.recipe.digest },
            ctx.work.id,
          )
          if (purpose === 'cover') {
            await tx.execute(sql`
              UPDATE content_items
                 SET cover_membership_id = ${added.membershipId}::uuid, updated_at = now(),
                     row_version = row_version + 1
               WHERE model_id = ${model}::uuid AND id = ${owner.item_id}::uuid`)
          }
          await enqueueWork(tx, {
            modelId: model,
            kind: 'derive_image',
            workKey: `derive:${blob.sha256}`,
            inputSha256: sha,
            assetVersionId: added.versionId,
            priority: 1_000_000,
            pipelineVersion: env.pipelineVersion,
          })
        },
      }
    } catch (error) {
      throw asWorkError(error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
