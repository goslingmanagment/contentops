import type { Db, Queryable } from '@contentops/db'
import {
  canonicalJson,
  DEFAULT_PLATFORM_PROFILE,
  type DigestedRecipe,
  detectToolVersions,
  masterRecipe,
  type PlatformProfile,
  photoRecipes,
  platformRecipe,
  probeRecipe,
  sha256Hex,
  type ToolVersions,
  videoDerivativeRecipes,
} from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { BlobStore } from './storage'

/**
 * What every media handler shares: the database, the store, the pinned tool versions and
 * the recipes they give, the encoder settings of the role.
 */
export interface MediaEnv {
  db: Db
  store: BlobStore
  versions: ToolVersions
  recipes: PipelineRecipes
  /** `SVTAV1_LP` of the master encode. */
  lp: number
  /** Extra niceness of the tool processes (the role itself runs under `nice`). */
  niceness?: number
  platform: PlatformProfile
  /** `pipeline_versions.version` that is current for this image. */
  pipelineVersion: string
  /** Lease owner prefix of the role: storage operations carry it. */
  owner: string
  log: (line: string, error?: unknown) => void
}

export interface PipelineRecipes {
  master: DigestedRecipe
  probeVideo: DigestedRecipe
  probePhoto: DigestedRecipe
  video: ReturnType<typeof videoDerivativeRecipes>
  photo: ReturnType<typeof photoRecipes>
  platform: { kept: DigestedRecipe; stripped: DigestedRecipe }
}

export function pipelineRecipes(
  versions: ToolVersions,
  lp: number,
  platform: PlatformProfile = DEFAULT_PLATFORM_PROFILE,
): PipelineRecipes {
  const photo = photoRecipes(versions)
  return {
    master: masterRecipe(versions, lp),
    probeVideo: probeRecipe(versions),
    probePhoto: photo.probe,
    video: videoDerivativeRecipes(versions),
    photo,
    platform: {
      kept: platformRecipe(versions, platform, false),
      stripped: platformRecipe(versions, platform, true),
    },
  }
}

/** `recipe_digests` of `pipeline_versions`: one digest per output kind. */
export function recipeDigests(recipes: PipelineRecipes): Record<string, string> {
  const digests: Record<string, string> = {
    master: recipes.master.digest,
    'probe.video': recipes.probeVideo.digest,
    'probe.photo': recipes.probePhoto.digest,
    platform: recipes.platform.kept.digest,
    'platform.stripped': recipes.platform.stripped.digest,
  }
  for (const [kind, r] of Object.entries(recipes.video)) digests[`video.${kind}`] = r.digest
  for (const [kind, r] of Object.entries(recipes.photo)) digests[`photo.${kind}`] = r.digest
  return digests
}

/** The version id: a digest of all recipe digests, stable for one image and settings. */
export function pipelineVersionOf(recipes: PipelineRecipes): string {
  return `pv-${sha256Hex(canonicalJson(recipeDigests(recipes))).slice(0, 12)}`
}

/**
 * The current `pipeline_versions` row of this image (schema §3.1): inserted if new and made
 * current on start of the media roles. Several roles starting at once agree under an
 * advisory lock; a new recipe of one kind rebuilds only that kind (its own digest).
 */
export async function activatePipelineVersion(
  db: Db,
  versions: ToolVersions,
  recipes: PipelineRecipes,
): Promise<{ version: string; activated: boolean }> {
  const version = pipelineVersionOf(recipes)
  const renditionRecipes = {
    video: Object.fromEntries(Object.entries(recipes.video).map(([k, r]) => [k, r.recipe])),
    photo: Object.fromEntries(Object.entries(recipes.photo).map(([k, r]) => [k, r.recipe])),
    platform: { kept: recipes.platform.kept.recipe, stripped: recipes.platform.stripped.recipe },
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('pipeline_versions', 0))`)
    await tx.execute(sql`
      INSERT INTO pipeline_versions (
        version, ffmpeg, svtav1, libvips, sharp, phash_algo, master_recipe, rendition_recipes,
        recipe_digests
      ) VALUES (
        ${version}, ${versions.ffmpeg}, ${versions.svtav1}, ${versions.libvips}, ${versions.sharp},
        ${versions.phash}, ${JSON.stringify(recipes.master.recipe)}::jsonb,
        ${JSON.stringify(renditionRecipes)}::jsonb, ${JSON.stringify(recipeDigests(recipes))}::jsonb
      )
      ON CONFLICT (version) DO NOTHING`)
    const { rows } = await tx.execute<{ is_current: boolean }>(
      sql`SELECT is_current FROM pipeline_versions WHERE version = ${version}`,
    )
    if (rows[0]?.is_current) return { version, activated: false }
    await tx.execute(sql`UPDATE pipeline_versions SET is_current = false WHERE is_current`)
    await tx.execute(sql`
      UPDATE pipeline_versions SET is_current = true, activated_at = coalesce(activated_at, now())
       WHERE version = ${version}`)
    return { version, activated: true }
  })
}

export async function currentPipelineVersion(q: Queryable): Promise<string | null> {
  const { rows } = await q.execute<{ version: string }>(
    sql`SELECT version FROM pipeline_versions WHERE is_current`,
  )
  return rows[0]?.version ?? null
}

export interface MediaEnvOptions {
  db: Db
  store: BlobStore
  lp: number
  owner: string
  log: MediaEnv['log']
  platform?: PlatformProfile
  versions?: ToolVersions
  niceness?: number
  /** Register and activate the version (media roles on start); default true. */
  activate?: boolean
}

export async function createMediaEnv(options: MediaEnvOptions): Promise<MediaEnv> {
  const versions = options.versions ?? (await detectToolVersions())
  const platform = options.platform ?? DEFAULT_PLATFORM_PROFILE
  const recipes = pipelineRecipes(versions, options.lp, platform)
  const pipelineVersion =
    options.activate === false
      ? pipelineVersionOf(recipes)
      : (await activatePipelineVersion(options.db, versions, recipes)).version
  return {
    db: options.db,
    store: options.store,
    versions,
    recipes,
    lp: options.lp,
    ...(options.niceness === undefined ? {} : { niceness: options.niceness }),
    platform,
    pipelineVersion,
    owner: options.owner,
    log: options.log,
  }
}
