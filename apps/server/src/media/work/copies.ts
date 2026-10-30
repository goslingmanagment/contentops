import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tx, WorkContext, WorkHandler } from '@contentops/db'
import { WorkError } from '@contentops/db'
import {
  buildCompatibleCopy,
  buildPlatformCopy,
  buildUniqVersion,
  type UniqLevel,
} from '@contentops/media'
import { sql } from 'drizzle-orm'
import { locateInput, probeVideoCached } from '../inputs'
import type { MediaEnv } from '../pipeline'
import {
  abandonBuilding,
  buildDir,
  createGeneration,
  finishGenerations,
  placeArtifacts,
  readyGeneration,
} from '../renditions'
import { exportKey, fsyncDir, shaBytes } from '../storage'
import { registerBlob } from '../storage-ops'
import { asWorkError, inputSha, modelOf, progressReporter } from './common'

/**
 * Copies that the manager waits for or that the plan asks in advance (SPEC §9.3):
 * `render` — `platform.mp4`, cached in `derived/` under its key with the strip mode;
 * `render_compat` — the compatible H.264 copy, an issue in the exports folder, never kept;
 * `uniq_render` — a unique FYP version, a durable asset with provenance.
 */

/** `scope` of `render` / `render_compat`: whether the copy is stripped of metadata. */
export type StripScope = 'stripped' | 'kept'

export function renderKey(masterHex: string, digest: string): string {
  return `render:${masterHex}:${digest}`
}

export function renderHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const master = inputSha(ctx)
    const stripped = ctx.work.scope === 'stripped'
    const recipe = stripped ? env.recipes.platform.stripped : env.recipes.platform.kept
    const key = { kind: 'platform' as const, recipeDigest: recipe.digest, metaStripped: stripped }
    const ready = await readyGeneration(env.db, {
      ...key,
      masterSha256: master,
      inputSha256: master,
    })
    if (ready) return { outputRef: ready.id, report: { generation: ready.id, cached: true } }
    const input = await locateInput(env, master)
    let dir: string | null = null
    try {
      const probe = await probeVideoCached(env, input, ctx.signal)
      await abandonBuilding(env, ctx.work.id)
      const generationId = await createGeneration(env.db, {
        ...key,
        masterSha256: master,
        inputKind: 'master',
        inputSha256: master,
        workId: ctx.work.id,
      })
      dir = await buildDir(env, ctx.work.id, ctx.work.attemptNo)
      const progress = progressReporter(ctx, 'копия для платформы', 2_000)
      const copy = await buildPlatformCopy({
        input: input.path,
        outDir: dir,
        metaStripped: stripped,
        profile: env.platform,
        probe,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
        onProgress: (p) => progress(p.fraction),
      })
      const placed = await placeArtifacts(env, () => generationId, [copy.file])
      return {
        outputRef: generationId,
        report: { generation: generationId, bytes: copy.file.bytes, sha256: copy.file.sha256 },
        commit: (tx) => finishGenerations(tx, placed, [generationId]),
      }
    } catch (error) {
      throw asWorkError(error)
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
}

/** What an exports-folder copy reports to the issue that waits for it. */
export interface ExportFile {
  key: string
  name: string
  sha256: string
  bytes: number
  mime: string
  width: number
  height: number
  duration_ms: number | null
}

/** `compat:<receipt>`: the receipt id names the exports folder the copy goes to. */
export function compatKey(receiptId: string): string {
  return `compat:${receiptId}`
}

export function renderCompatHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const master = inputSha(ctx)
    const receiptId = ctx.work.workKey.slice('compat:'.length)
    const stripped = ctx.work.scope === 'stripped'
    const dir = env.store.path(exportKey(receiptId, 'compat'))
    try {
      const input = await locateInput(env, master)
      const probe = await probeVideoCached(env, input, ctx.signal)
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const progress = progressReporter(ctx, 'копия, которая откроется везде', 2_000)
      const copy = await buildCompatibleCopy({
        input: input.path,
        outDir: dir,
        metaStripped: stripped,
        probe,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
        onProgress: (p) => progress(p.fraction),
      })
      await fsyncDir(dir)
      const file: ExportFile = {
        key: exportKey(receiptId, `compat/${copy.file.name}`),
        name: copy.file.name,
        sha256: copy.file.sha256,
        bytes: copy.file.bytes,
        mime: copy.file.mime,
        width: copy.file.width,
        height: copy.file.height,
        duration_ms: copy.file.durationMs,
      }
      return { outputRef: file.key, report: { file } }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw asWorkError(error)
    }
  }
}

const UNIQ_LEVELS: readonly UniqLevel[] = ['soft', 'trim', 'mirror']

/** `uniq:<parent version>:<level>:<n>` (schema §3.4). */
export function uniqKey(parentVersionId: string, level: UniqLevel, n: number): string {
  return `uniq:${parentVersionId}:${level}:${n}`
}

function parseUniqKey(workKey: string): { level: UniqLevel; n: number } {
  const [, , level, n] = workKey.split(':')
  if (!UNIQ_LEVELS.includes(level as UniqLevel) || !n || !/^\d+$/.test(n)) {
    throw new WorkError('permanent', 'bad_key', `bad uniq key ${workKey}`)
  }
  return { level: level as UniqLevel, n: Number(n) }
}

interface ParentVersion extends Record<string, unknown> {
  item_id: string
  item_type: string
  asset_id: string
  master_sha256: Buffer
}

async function parentOf(q: Tx | MediaEnv['db'], ctx: WorkContext): Promise<ParentVersion> {
  const model = modelOf(ctx)
  const { rows } = await q.execute<ParentVersion>(sql`
    SELECT m.item_id, m.item_type, v.asset_id, v.master_sha256
      FROM asset_versions v
      JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
     WHERE v.model_id = ${model}::uuid AND v.id = ${ctx.work.assetVersionId}::uuid`)
  const row = rows[0]
  if (!row) throw new WorkError('permanent', 'no_parent', 'the montage version is gone')
  return row
}

/**
 * A unique FYP version (SPEC §9.3, §4): one encode into the platform profile with the
 * deterministic zoom/speed/trim/mirror of its number; a durable asset `uN` of the same FYP
 * with `uniq_from` provenance carrying the profile, level and number. Built once per key.
 */
export function uniqRenderHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const { level, n } = parseUniqKey(ctx.work.workKey)
    const model = modelOf(ctx)
    const parent = await parentOf(env.db, ctx)
    if (parent.item_type !== 'FYP') {
      throw new WorkError('permanent', 'not_fyp', 'unique versions are built for FYP only')
    }
    const existing = await env.db.execute<{ id: string }>(sql`
      SELECT id FROM assets WHERE model_id = ${model}::uuid AND created_in_item_id = ${parent.item_id}::uuid
         AND variant_kind = 'uniq' AND variant_no = ${n}`)
    if (existing.rows[0]) return { report: { asset: existing.rows[0].id, cached: true } }
    const input = await locateInput(env, parent.master_sha256)
    const dir = join(env.store.incomingDir, `uniq-${ctx.work.id}-${ctx.work.attemptNo}`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    try {
      const probe = await probeVideoCached(env, input, ctx.signal)
      const progress = progressReporter(ctx, `версия ${n}`)
      const built = await buildUniqVersion({
        input: input.path,
        outDir: dir,
        level,
        n,
        profile: env.platform,
        probe,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
        onProgress: (p) => progress(p.fraction),
      })
      const blob = await registerBlob(env.db, env.store, {
        file: built.file.path,
        sha256: built.file.sha256,
        ext: 'mp4',
        mediaKind: 'video',
        mime: 'video/mp4',
        move: true,
        owner: env.owner,
      })
      const sha = shaBytes(blob.sha256)
      return {
        outputSha256: sha,
        report: { n, level, sha256: blob.sha256, recipe: built.recipe.digest },
        commit: async (tx) => {
          const assetId = randomUUID()
          const versionId = randomUUID()
          await tx.execute(sql`
            INSERT INTO assets (model_id, id, created_in_item_id, media_kind, current_version_id,
                                variant_kind, variant_no, uniq_level)
            VALUES (${model}::uuid, ${assetId}::uuid, ${parent.item_id}::uuid, 'video',
                    ${versionId}::uuid, 'uniq', ${n}, ${level})`)
          await tx.execute(sql`
            INSERT INTO asset_versions (model_id, id, asset_id, version_no, master_sha256, work_id,
                                        duration_ms, width, height)
            VALUES (${model}::uuid, ${versionId}::uuid, ${assetId}::uuid, 1, ${sha},
                    ${ctx.work.id}::uuid, ${built.file.durationMs}, ${built.file.width},
                    ${built.file.height})`)
          await tx.execute(sql`
            INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role)
            VALUES (${model}::uuid, ${parent.item_id}::uuid, 'FYP', ${assetId}::uuid, ${n}, 'owned', 'master')`)
          await tx.execute(sql`
            INSERT INTO provenance (model_id, relation, child_version_id, parent_version_id, params,
                                    basis, work_id)
            VALUES (${model}::uuid, 'uniq_from', ${versionId}::uuid, ${ctx.work.assetVersionId}::uuid,
                    ${JSON.stringify({ ...built.params, profile: env.platform.id, recipe: built.recipe.digest })}::jsonb,
                    'uniq_render', ${ctx.work.id}::uuid)`)
        },
      }
    } catch (error) {
      throw asWorkError(error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
