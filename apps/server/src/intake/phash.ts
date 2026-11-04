import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'

/** A photo's pHash is 64 bits (sharp-phash, SPEC §12.0); the distance is the bits that differ. */
export const PHASH_BITS = 64

/**
 * «Похожесть кадров» on «Пороги» is a percent (values are kept in the screen's units): 90 % — at
 * most a tenth of the 64 bits differ. The largest pHash distance that is still «похоже»; a value
 * outside 0–100 gives no hints.
 */
export function phashMaxDistance(percent: number): number | null {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  return Math.floor((PHASH_BITS * (100 - percent)) / 100)
}

/**
 * `phash_suggest_threshold` of the model, else the one for everything, as the largest distance;
 * `null` — not set, no hints (schema §9.2).
 */
export async function phashSuggestDistance(q: Queryable, modelId: string): Promise<number | null> {
  const { rows } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = 'phash_suggest_threshold' AND account_id IS NULL AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${modelId}::uuid) AND value IS NOT NULL
     ORDER BY model_id NULLS LAST LIMIT 1`)
  const value = rows[0]?.value
  return typeof value === 'number' ? phashMaxDistance(value) : null
}
