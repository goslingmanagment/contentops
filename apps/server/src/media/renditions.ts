import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Queryable, Tx, values } from '@contentops/db'
import type { Artifact } from '@contentops/media'
import { sql } from 'drizzle-orm'
import type { MediaEnv } from './pipeline'
import { derivedKey, fsyncDir, shaBytes } from './storage'

type RenditionKind = values.RenditionKind

/**
 * Rendition generations (schema §3.3, SPEC §9.1, §9.3). The key of a derivative is
 * `(master_sha256, kind, recipe_digest, meta_stripped)`; a physical build is a generation
 * with its own id and an immutable address `derived/gen/<id>/<name>`. The first previews
 * are built from the source before the master hash exists and are bound to it once the
 * master is verified; a rebuild is a new generation, switched to active under the key lock.
 */

export interface GenerationKey {
  kind: RenditionKind
  recipeDigest: string
  metaStripped: boolean
}

export interface ReadyGeneration {
  id: string
  masterSha256: Buffer | null
}

/** A ready generation of the key: active for a master, else any ready one built from `input`. */
export async function readyGeneration(
  q: Queryable,
  key: GenerationKey & { masterSha256: Buffer | null; inputSha256: Buffer },
): Promise<ReadyGeneration | null> {
  if (key.masterSha256) {
    const { rows } = await q.execute<{ id: string; master_sha256: Buffer | null }>(sql`
      SELECT id, master_sha256 FROM rendition_generations
       WHERE master_sha256 = ${key.masterSha256} AND kind = ${key.kind}
         AND recipe_digest = ${key.recipeDigest} AND meta_stripped = ${key.metaStripped}
         AND is_active AND state = 'ready'`)
    const row = rows[0]
    if (row) return { id: row.id, masterSha256: row.master_sha256 }
  }
  const { rows } = await q.execute<{ id: string; master_sha256: Buffer | null }>(sql`
    SELECT id, master_sha256 FROM rendition_generations
     WHERE input_sha256 = ${key.inputSha256} AND kind = ${key.kind}
       AND recipe_digest = ${key.recipeDigest} AND meta_stripped = ${key.metaStripped}
       AND state = 'ready'
     ORDER BY ready_at DESC LIMIT 1`)
  const row = rows[0]
  return row ? { id: row.id, masterSha256: row.master_sha256 } : null
}

/**
 * A hash is a verified master when some version or draft holds it as its master: then its
 * renditions are keyed by it at once (input kind `master`).
 */
export async function isVerifiedMaster(q: Queryable, sha: Buffer): Promise<boolean> {
  const { rows } = await q.execute<{ yes: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM asset_versions WHERE master_sha256 = ${sha})
        OR EXISTS (SELECT 1 FROM inbox_drafts
                    WHERE master_sha256 = ${sha} AND master_verified_at IS NOT NULL) AS yes`)
  return rows[0]?.yes === true
}

/**
 * Generations an earlier attempt of the same work left `building` are failed and their
 * directories removed: a retry never reuses half-written files (PLAN 2б).
 */
export async function abandonBuilding(env: MediaEnv, workId: string): Promise<void> {
  const { rows } = await env.db.execute<{ id: string }>(sql`
    UPDATE rendition_generations SET state = 'failed'
     WHERE work_id = ${workId}::uuid AND state = 'building'
    RETURNING id`)
  for (const { id } of rows) await env.store.delete(`derived/gen/${id}`)
}

export async function createGeneration(
  q: Queryable,
  input: GenerationKey & {
    masterSha256: Buffer | null
    inputKind: 'source' | 'master'
    inputSha256: Buffer
    workId: string | null
  },
): Promise<string> {
  const { rows } = await q.execute<{ id: string }>(sql`
    INSERT INTO rendition_generations (
      master_sha256, kind, recipe_digest, meta_stripped, input_kind, input_sha256, work_id
    ) VALUES (
      ${input.masterSha256}, ${input.kind}, ${input.recipeDigest}, ${input.metaStripped},
      ${input.inputKind}, ${input.inputSha256}, ${input.workId}::uuid
    ) RETURNING id`)
  return rows[0]?.id as string
}

/** Serialises switches of one derivative key (schema §9.1 «переключение поколения»). */
export async function lockKey(tx: Tx, master: Buffer, key: GenerationKey): Promise<void> {
  const name = `rendition:${master.toString('hex')}:${key.kind}:${key.recipeDigest}:${key.metaStripped}`
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`)
}

/**
 * Makes a ready generation the active one of its key; the previous one stays readable under
 * its own address until the collector removes it.
 */
export async function activateGeneration(tx: Tx, generationId: string): Promise<void> {
  const { rows } = await tx.execute<{
    master_sha256: Buffer | null
    kind: RenditionKind
    recipe_digest: string
    meta_stripped: boolean
  }>(sql`
    SELECT master_sha256, kind, recipe_digest, meta_stripped FROM rendition_generations
     WHERE id = ${generationId}::uuid`)
  const row = rows[0]
  if (!row?.master_sha256) return
  const key = { kind: row.kind, recipeDigest: row.recipe_digest, metaStripped: row.meta_stripped }
  await lockKey(tx, row.master_sha256, key)
  await tx.execute(sql`
    UPDATE rendition_generations SET is_active = false
     WHERE master_sha256 = ${row.master_sha256} AND kind = ${row.kind}
       AND recipe_digest = ${row.recipe_digest} AND meta_stripped = ${row.meta_stripped}
       AND is_active AND id <> ${generationId}::uuid`)
  await tx.execute(sql`
    UPDATE rendition_generations SET is_active = true WHERE id = ${generationId}::uuid`)
}

/** Files of the build, moved into `derived/gen/<generation>/` (same filesystem). */
export async function placeArtifacts(
  env: MediaEnv,
  generationOf: (artifact: Artifact) => string,
  artifacts: Artifact[],
): Promise<{ generationId: string; artifact: Artifact; key: string }[]> {
  const placed: { generationId: string; artifact: Artifact; key: string }[] = []
  const dirs = new Set<string>()
  for (const artifact of artifacts) {
    const generationId = generationOf(artifact)
    const key = derivedKey(generationId, artifact.name)
    const stored = await env.store.place(artifact.path, key)
    dirs.add(join(stored.path, '..'))
    placed.push({ generationId, artifact, key })
  }
  for (const dir of dirs) await fsyncDir(dir)
  return placed
}

/** Rows of the placed files and the generations ready, in the finishing transaction. */
export async function finishGenerations(
  tx: Tx,
  placed: { generationId: string; artifact: Artifact; key: string }[],
  generationIds: string[],
): Promise<void> {
  for (const { generationId, artifact, key } of placed) {
    await tx.execute(sql`
      INSERT INTO rendition_artifacts (
        generation_id, name, output_sha256, byte_size, mime, width, height, duration_ms,
        frame_ms, storage_key
      ) VALUES (
        ${generationId}::uuid, ${artifact.name}, ${shaBytes(artifact.sha256)}, ${artifact.bytes},
        ${artifact.mime}, ${artifact.width || null}, ${artifact.height || null},
        ${artifact.durationMs}, ${artifact.frameMs}, ${key}
      )
      ON CONFLICT (generation_id, name) DO NOTHING`)
  }
  for (const id of generationIds) {
    await tx.execute(sql`
      UPDATE rendition_generations SET state = 'ready', ready_at = now()
       WHERE id = ${id}::uuid AND state = 'building'`)
    await activateGeneration(tx, id)
  }
}

/**
 * Binds the generations built from a source to its verified master (schema §3.3): once,
 * `bound_at`; the address does not change. The newest bound generation of each key becomes
 * active unless the key already has an active ready one.
 */
export async function bindGenerations(
  tx: Tx,
  sourceSha: Buffer,
  masterSha: Buffer,
): Promise<number> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE rendition_generations SET master_sha256 = ${masterSha}, bound_at = now()
     WHERE input_sha256 = ${sourceSha} AND input_kind = 'source' AND master_sha256 IS NULL
       AND state IN ('building', 'ready')
    RETURNING id`)
  const { rows: ready } = await tx.execute<{ id: string }>(sql`
    SELECT DISTINCT ON (kind, recipe_digest, meta_stripped) id FROM rendition_generations g
     WHERE master_sha256 = ${masterSha} AND state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM rendition_generations a
          WHERE a.master_sha256 = g.master_sha256 AND a.kind = g.kind
            AND a.recipe_digest = g.recipe_digest AND a.meta_stripped = g.meta_stripped
            AND a.is_active AND a.state = 'ready')
     ORDER BY kind, recipe_digest, meta_stripped, ready_at DESC`)
  for (const { id } of ready) await activateGeneration(tx, id)
  return rows.length
}

/** A private work dir for one build inside `DERIVED_ROOT/.tmp` (same filesystem as `gen/`). */
export async function buildDir(env: MediaEnv, workId: string, attempt: number): Promise<string> {
  const dir = join(env.store.derivedTmpDir, `${workId}-${attempt}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}
