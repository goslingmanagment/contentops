import type { Db, Queryable, values } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import type { MediaEnv } from './pipeline'
import { lockKey } from './renditions'
import type { BlobStore } from './storage'

/**
 * The generation collector (SPEC §9.1, schema §3.3): a rebuilt derivative — from the master
 * instead of the source, or by a new recipe of its kind — is served by its new generation,
 * and the old one goes once nothing needs it any more. Its files under `derived/gen/<id>/`
 * are removed; the rows stay as `evicted`, so a receipt still knows what was issued.
 *
 * A ready generation bound to a master is collected when
 * - its key (master, kind, strip mode) has another generation that is active, ready, of a
 *   recipe of the current pipeline version, and has served for a day (`graceMs`: open
 *   screens still hold the old address in the catalog index for a while);
 * - it is not itself the active generation of a current recipe;
 * - nothing points at it: an unfinished work, a chronology frame (a future teaser), or a
 *   receipt issued within the same day (its download link is still being used).
 *
 * Unbound generations (a draft's previews from the source) are never touched here. Runs in
 * `worker` every hour; every reference to generations and artifacts in the schema must be
 * one of `HOLDERS` (the test compares it with the foreign keys).
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** Foreign keys onto `rendition_generations` / `rendition_artifacts` and how each one holds. */
export const HOLDERS = {
  'rendition_artifacts.generation_id': 'the files of the generation itself',
  'work_operations.generation_id': 'an unfinished work',
  'chronology_entries.frame_artifact_id': 'always: a frame that may become a teaser',
  'download_receipt_entries.rendition_artifact_id': 'a receipt issued within the grace period',
} as const

const UNFINISHED: readonly values.WorkState[] = ['pending', 'running', 'retry_wait']

export interface CollectOptions {
  /** How long the new generation serves (and a receipt holds) before the old one goes. */
  graceMs?: number
  /** Generations per run; the next run takes the rest. */
  limit?: number
}

export interface CollectReport {
  evicted: string[]
  bytes: number
}

function superseded(graceMs: number): SQL {
  const grace = `${Math.max(0, Math.floor(graceMs))} milliseconds`
  return sql`
    g.state = 'ready' AND g.master_sha256 IS NOT NULL
    AND NOT (g.is_active AND g.recipe_digest IN (SELECT digest FROM current_recipes))
    AND EXISTS (
      SELECT 1 FROM rendition_generations w
       WHERE w.master_sha256 = g.master_sha256 AND w.kind = g.kind
         AND w.meta_stripped = g.meta_stripped AND w.id <> g.id
         AND w.is_active AND w.state = 'ready'
         AND w.recipe_digest IN (SELECT digest FROM current_recipes)
         AND w.ready_at <= now() - ${grace}::interval)
    AND NOT EXISTS (
      SELECT 1 FROM work_operations o
       WHERE o.generation_id = g.id AND o.state IN (${sql.join(
         UNFINISHED.map((s) => sql`${s}`),
         sql`, `,
       )}))
    AND NOT EXISTS (
      SELECT 1 FROM rendition_artifacts a
        JOIN chronology_entries c ON c.frame_artifact_id = a.id
       WHERE a.generation_id = g.id)
    AND NOT EXISTS (
      SELECT 1 FROM rendition_artifacts a
        JOIN download_receipt_entries e ON e.rendition_artifact_id = a.id
        JOIN download_receipts r ON r.model_id = e.model_id AND r.id = e.receipt_id
       WHERE a.generation_id = g.id AND r.issued_at > now() - ${grace}::interval)`
}

const CURRENT_RECIPES = sql`
  WITH current_recipes AS (
    SELECT DISTINCT d.value AS digest
      FROM pipeline_versions p, jsonb_each_text(p.recipe_digests) d
     WHERE p.is_current)`

async function candidates(q: Queryable, graceMs: number, limit: number): Promise<string[]> {
  const { rows } = await q.execute<{ id: string }>(sql`
    ${CURRENT_RECIPES}
    SELECT g.id FROM rendition_generations g
     WHERE ${superseded(graceMs)}
     ORDER BY g.ready_at
     LIMIT ${limit}`)
  return rows.map((r) => r.id)
}

/**
 * One pass: each candidate is re-checked under its key lock and row lock, its directory is
 * removed, then its rows become `evicted` in the same transaction. A crash after the files
 * leaves the rows `ready`; the next pass finds the same generation and finishes it.
 */
export async function collectGenerations(
  db: Db,
  store: BlobStore,
  options: CollectOptions = {},
): Promise<CollectReport> {
  const graceMs = options.graceMs ?? DAY_MS
  const report: CollectReport = { evicted: [], bytes: 0 }
  for (const id of await candidates(db, graceMs, options.limit ?? 500)) {
    const bytes = await db.transaction(async (tx) => {
      const { rows } = await tx.execute<{
        master_sha256: Buffer
        kind: values.RenditionKind
        recipe_digest: string
        meta_stripped: boolean
      }>(sql`
        SELECT master_sha256, kind, recipe_digest, meta_stripped FROM rendition_generations
         WHERE id = ${id}::uuid AND state = 'ready' AND master_sha256 IS NOT NULL`)
      const row = rows[0]
      if (!row) return null
      await lockKey(tx, row.master_sha256, {
        kind: row.kind,
        recipeDigest: row.recipe_digest,
        metaStripped: row.meta_stripped,
      })
      const { rows: still } = await tx.execute<{ bytes: string | null }>(sql`
        ${CURRENT_RECIPES}
        SELECT (SELECT sum(byte_size) FROM rendition_artifacts
                 WHERE generation_id = g.id AND state = 'ready') AS bytes
          FROM rendition_generations g
         WHERE g.id = ${id}::uuid AND ${superseded(graceMs)}
           FOR UPDATE OF g`)
      if (still.length === 0) return null
      await store.delete(`derived/gen/${id}`)
      await tx.execute(sql`
        UPDATE rendition_generations SET state = 'evicted', is_active = false
         WHERE id = ${id}::uuid`)
      await tx.execute(sql`
        UPDATE rendition_artifacts SET state = 'evicted' WHERE generation_id = ${id}::uuid`)
      return Number(still[0]?.bytes ?? 0)
    })
    if (bytes === null) continue
    report.evicted.push(id)
    report.bytes += bytes
  }
  return report
}

/** Starts the hourly collector of `worker`; returns the stop function. */
export function startGenerationCollector(
  db: Db,
  store: BlobStore,
  log: MediaEnv['log'],
  everyMs = 60 * 60 * 1000,
): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    collectGenerations(db, store)
      .then(({ evicted, bytes }) => {
        if (evicted.length > 0) {
          log(`renditions: removed ${evicted.length} old generations, ${bytes} bytes`)
        }
      })
      .catch((error: unknown) => log('rendition collector failed', error))
      .finally(() => {
        running = false
      })
  }
  run()
  const timer = setInterval(run, everyMs)
  return () => clearInterval(timer)
}
