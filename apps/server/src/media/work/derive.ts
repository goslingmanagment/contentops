import { rm } from 'node:fs/promises'
import type { WorkContext, WorkHandler, WorkSuccess } from '@contentops/db'
import {
  type Artifact,
  buildVideoDerivatives,
  PHOTO_DERIVATIVE_KINDS,
  type PhotoDerivativeKind,
  processPhoto,
  VIDEO_DERIVATIVE_KINDS,
  type VideoDerivativeKind,
} from '@contentops/media'
import { sql } from 'drizzle-orm'
import { locateInput, probePhotoCached, probeVideoCached, savePhotoProbe } from '../inputs'
import type { MediaEnv } from '../pipeline'
import {
  abandonBuilding,
  bindGenerations,
  buildDir,
  createGeneration,
  finishGenerations,
  isVerifiedMaster,
  placeArtifacts,
  readyGeneration,
} from '../renditions'
import { asWorkError, inputSha, masterOfSource, progressReporter } from './common'

/**
 * `derive_video` and `derive_image` (schema §3.4, SPEC §9.3, §12.0): one decoding pass per
 * input gives what is missing of preview, poster, thumbnails and annotation frames (photo:
 * EXIF and orientation, preview-2048, thumbnails, frame, pHash). What is already built for
 * the same bytes and recipe is not built again; a retry starts from a clean build dir.
 */

type Kind = VideoDerivativeKind | PhotoDerivativeKind

interface Plan<K extends Kind> {
  todo: K[]
  /** `master` when the input is itself a verified master, else `source`. */
  inputKind: 'source' | 'master'
  masterSha256: Buffer | null
}

async function planKinds<K extends Kind>(
  env: MediaEnv,
  sha: Buffer,
  kinds: readonly K[],
  digestOf: (kind: K) => string,
): Promise<Plan<K>> {
  const isMaster = await isVerifiedMaster(env.db, sha)
  const masterSha256 = isMaster ? sha : null
  const todo: K[] = []
  for (const kind of kinds) {
    const ready = await readyGeneration(env.db, {
      kind,
      recipeDigest: digestOf(kind),
      metaStripped: false,
      masterSha256,
      inputSha256: sha,
    })
    if (!ready) todo.push(kind)
  }
  return { todo, inputKind: isMaster ? 'master' : 'source', masterSha256 }
}

async function createGenerations<K extends Kind>(
  env: MediaEnv,
  ctx: WorkContext,
  sha: Buffer,
  plan: Plan<K>,
  digestOf: (kind: K) => string,
): Promise<Map<K, string>> {
  await abandonBuilding(env, ctx.work.id)
  const ids = new Map<K, string>()
  for (const kind of plan.todo) {
    ids.set(
      kind,
      await createGeneration(env.db, {
        kind,
        recipeDigest: digestOf(kind),
        metaStripped: false,
        masterSha256: plan.masterSha256,
        inputKind: plan.inputKind,
        inputSha256: sha,
        workId: ctx.work.id,
      }),
    )
  }
  return ids
}

function finish<K extends Kind>(
  env: MediaEnv,
  sha: Buffer,
  ids: Map<K, string>,
  artifacts: Artifact[],
  extra?: WorkSuccess['commit'],
): Promise<WorkSuccess['commit']> {
  return (async () => {
    const placed = await placeArtifacts(env, (a) => ids.get(a.kind as K) as string, artifacts)
    return async (tx) => {
      await finishGenerations(tx, placed, [...ids.values()])
      // Encoded or accepted before this pass finished: bind now, not at the next intake.
      const master = await masterOfSource(tx, sha)
      if (master) await bindGenerations(tx, sha, master)
      await extra?.(tx)
    }
  })()
}

export function deriveVideoHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const sha = inputSha(ctx)
    const digestOf = (kind: VideoDerivativeKind) => env.recipes.video[kind].digest
    const plan = await planKinds(env, sha, VIDEO_DERIVATIVE_KINDS, digestOf)
    if (plan.todo.length === 0) return { report: { built: [], cached: true } }
    const input = await locateInput(env, sha)
    let dir: string | null = null
    try {
      const probe = await probeVideoCached(env, input, ctx.signal)
      const ids = await createGenerations(env, ctx, sha, plan, digestOf)
      dir = await buildDir(env, ctx.work.id, ctx.work.attemptNo)
      const progress = progressReporter(ctx, 'превью и кадры')
      const result = await buildVideoDerivatives({
        input: input.path,
        outDir: dir,
        kinds: plan.todo,
        probe,
        signal: ctx.signal,
        ...(env.niceness === undefined ? {} : { niceness: env.niceness }),
        versions: env.versions,
        onProgress: (p) => progress(p.fraction),
      })
      const commit = await finish(env, sha, ids, result.artifacts)
      return {
        report: {
          built: plan.todo,
          files: result.artifacts.length,
          decode_errors: result.decodeErrors.count,
          ffmpeg_ms: result.ffmpegMs,
          total_ms: result.totalMs,
        },
        commit,
      }
    } catch (error) {
      throw asWorkError(error)
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
}

export function deriveImageHandler(env: MediaEnv): WorkHandler {
  return async (ctx) => {
    const sha = inputSha(ctx)
    const digestOf = (kind: PhotoDerivativeKind) => env.recipes.photo[kind].digest
    const phash = env.recipes.photo.phash
    const plan = await planKinds(env, sha, PHOTO_DERIVATIVE_KINDS, digestOf)
    const { rows } = await env.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM blob_phashes WHERE sha256 = ${sha} AND algo_version = ${env.versions.phash}`)
    const hasHash = (rows[0]?.n ?? 0) > 0
    if (plan.todo.length === 0 && hasHash) return { report: { built: [], cached: true } }
    const input = await locateInput(env, sha)
    let dir: string | null = null
    try {
      await probePhotoCached(env, input)
      const ids = await createGenerations(env, ctx, sha, plan, digestOf)
      dir = await buildDir(env, ctx.work.id, ctx.work.attemptNo)
      // The library builds every kind in one decode; the pHash comes from the same pass.
      const result = await processPhoto({
        input: input.path,
        outDir: dir,
        kinds: plan.todo.length > 0 ? plan.todo : ['frames'],
        signal: ctx.signal,
        versions: env.versions,
      })
      const wanted = result.artifacts.filter((a) => ids.has(a.kind as PhotoDerivativeKind))
      const commit = await finish(env, sha, ids, wanted, async (tx) => {
        await savePhotoProbe(tx, sha, env.recipes.probePhoto.digest, result.probe)
        await tx.execute(sql`
          INSERT INTO blob_phashes (sha256, algorithm, algo_version, normalization, phash)
          VALUES (${sha}, ${result.phash.algorithm}, ${result.phash.algoVersion},
                  ${result.phash.normalization}, ${result.phash.bits}::bit(64))
          ON CONFLICT DO NOTHING`)
      })
      return {
        report: {
          built: plan.todo,
          phash: result.phash.hex,
          phash_recipe: phash.digest,
          total_ms: result.totalMs,
        },
        commit,
      }
    } catch (error) {
      throw asWorkError(error)
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }
}
