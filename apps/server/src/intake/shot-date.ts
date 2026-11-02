import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * Day of shooting of accepted files (SPEC §6.3 «дата съёмки берётся из EXIF», schema
 * `content_items.shot_on`): the earliest EXIF time of their bytes — the probe of the source,
 * else of the master — and, without a probe, the time the source itself read from EXIF
 * (`remote_shot_at` of Я.Диск and Dropbox). A date in a folder name is no shooting date: it is
 * often the day of the release (legacy-and-import §2), so it stays a claim. A camera without a
 * clock writes 1970 or 2000: dates before 2015 or in the future are not taken.
 */
export async function shotOnOfDrafts(
  tx: Tx,
  modelId: string,
  draftIds: readonly string[],
): Promise<string | null> {
  if (draftIds.length === 0) return null
  const { rows } = await tx.execute<{ day: string | null }>(sql`
    WITH model AS (SELECT timezone AS tz FROM models WHERE id = ${modelId}::uuid),
    drafts AS (
      SELECT d.* FROM inbox_drafts d
       WHERE d.model_id = ${modelId}::uuid AND d.id = ANY (${sql.param([...draftIds])}::uuid[])
    ),
    exif AS (
      SELECT min(coalesce(p.shot_at_local::date, (p.shot_at AT TIME ZONE m.tz)::date)) AS day
        FROM drafts d
        CROSS JOIN model m
        JOIN blob_probes p ON p.sha256 IN (d.source_blob_sha256, d.source_sha256, d.master_sha256)
       WHERE coalesce(p.shot_at_local, p.shot_at AT TIME ZONE m.tz)
             BETWEEN timestamp '2015-01-01' AND (now() AT TIME ZONE m.tz) + interval '1 day'
    ),
    remote AS (
      SELECT min((r.remote_shot_at AT TIME ZONE m.tz)::date) AS day
        FROM drafts d
        CROSS JOIN model m
        JOIN source_revisions r ON r.model_id = d.model_id AND r.id = d.source_revision_id
       WHERE r.remote_shot_at BETWEEN timestamptz '2015-01-01' AND now() + interval '1 day'
    )
    SELECT coalesce((SELECT day FROM exif), (SELECT day FROM remote))::text AS day`)
  return rows[0]?.day ?? null
}

/** An object without a day gets the day of the files it is extended with. */
export async function fillShotOn(tx: Tx, modelId: string, itemId: string, day: string | null) {
  if (!day) return
  await tx.execute(sql`
    UPDATE content_items SET shot_on = ${day}::date, row_version = row_version + 1,
           updated_at = now()
     WHERE model_id = ${modelId}::uuid AND id = ${itemId}::uuid AND shot_on IS NULL`)
}
