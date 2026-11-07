import type { Queryable, Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * A suggestion reaches a field only while the field is a draft of the version the run saw
 * (schema §1 p. 7, SPEC §5, §8.3): the value is written, the field's version goes up and its
 * status stays a draft «черновик · ИИ» with the run as its source. A confirmed field, or one
 * changed after the run began, keeps its value: a late answer cannot overwrite what a person
 * confirmed, and the repeated markup confirms nothing. The object's row is locked first, in the
 * order of a person's edit, so the two never wait for each other in a circle.
 */

export interface FieldVersions {
  /** `value_version` of each field when the run was made; 0 — no status row yet. */
  [field: string]: number
}

interface StateRow extends Record<string, unknown> {
  field: string
  value_version: number
  confirmed: boolean
}

/** The versions of the fields as a run sees them: what its suggestions may replace. */
export async function fieldVersions(
  q: Queryable,
  modelId: string,
  itemId: string,
  versionId: string | null,
): Promise<FieldVersions> {
  const { rows } = await q.execute<StateRow>(sql`
    SELECT field, value_version::int AS value_version,
           confirmed_value_version IS NOT DISTINCT FROM value_version AS confirmed
      FROM annotation_fields
     WHERE model_id = ${modelId}::uuid
       AND (item_id = ${itemId}::uuid OR (${versionId}::uuid IS NOT NULL AND version_id = ${versionId}::uuid))`)
  const { rows: texts } = await q.execute<{ value_version: number }>(sql`
    SELECT coalesce(sum(value_version), 0)::int AS value_version FROM platform_texts
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND platform = 'generic'
       AND account_id IS NULL AND locale = 'en' AND variant_no IN (1, 2)`)
  return {
    ...Object.fromEntries(rows.map((row) => [row.field, row.value_version])),
    platform_texts: texts[0]?.value_version ?? 0,
  }
}

/**
 * Claims the status row of a field for the run's value: its new version, or `null` when the field
 * is confirmed or moved on. A missing row is made as a draft of version 1.
 */
async function claimField(
  tx: Tx,
  target: { modelId: string; itemId: string | null; versionId: string | null },
  field: string,
  seen: number,
  runId: string,
): Promise<number | null> {
  const { rows } = await tx.execute<{ value_version: number }>(sql`
    INSERT INTO annotation_fields (model_id, item_id, version_id, field, value_version,
                                   suggested_by_run_id)
    SELECT ${target.modelId}::uuid, ${target.itemId}::uuid, ${target.versionId}::uuid, ${field},
           1, ${runId}::uuid
     WHERE ${seen} = 0
    ON CONFLICT ON CONSTRAINT annotation_fields_target DO UPDATE
       SET value_version = annotation_fields.value_version + 1,
           suggested_by_run_id = excluded.suggested_by_run_id,
           updated_at = now(), updated_by = NULL
     WHERE annotation_fields.value_version = ${seen}
       AND annotation_fields.confirmed_value_version IS DISTINCT FROM annotation_fields.value_version
    RETURNING value_version::int AS value_version`)
  if (rows[0]) return rows[0].value_version
  if (seen === 0) return null
  const { rows: updated } = await tx.execute<{ value_version: number }>(sql`
    UPDATE annotation_fields
       SET value_version = value_version + 1, suggested_by_run_id = ${runId}::uuid,
           updated_at = now(), updated_by = NULL
     WHERE model_id = ${target.modelId}::uuid AND field = ${field}
       AND item_id IS NOT DISTINCT FROM ${target.itemId}::uuid
       AND version_id IS NOT DISTINCT FROM ${target.versionId}::uuid
       AND group_id IS NULL AND draft_id IS NULL
       AND value_version = ${seen}
       AND confirmed_value_version IS DISTINCT FROM value_version
    RETURNING value_version::int AS value_version`)
  return updated[0]?.value_version ?? null
}

/** A tag of the dictionary by its slug, or a free tag of the model made for it. */
async function tagId(tx: Tx, modelId: string, slug: string): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT coalesce(t.merged_into_tag_id, t.id) AS id FROM tags t
     WHERE (t.model_id IS NULL OR t.model_id = ${modelId}::uuid) AND t.slug = ${slug}
     ORDER BY t.model_id NULLS FIRST LIMIT 1`)
  if (rows[0]) return rows[0].id
  const { rows: made } = await tx.execute<{ id: string }>(sql`
    INSERT INTO tags (model_id, slug, label_ru) VALUES (${modelId}::uuid, ${slug}, ${slug})
    ON CONFLICT ON CONSTRAINT tags_slug DO UPDATE SET slug = excluded.slug
    RETURNING id`)
  const id = made[0]?.id
  if (!id) throw new Error(`tag ${slug} was not made`)
  return id
}

/** `Lace stockings!` → `lace-stockings`: the slug form of a tag the model writes. */
export function tagSlug(raw: string): string | null {
  const slug = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length >= 2 ? slug : null
}

export interface SuggestedValues {
  title?: string
  title_en?: string
  description?: string
  tags?: string[]
  /** Segments by moment: the moments of the frames the segments start at. */
  chronology?: { atMs: number; text: string }[]
  platform_texts?: { wall: string; message: string }
}

export interface ApplyTarget {
  modelId: string
  itemId: string
  /** The master version: the chronology is written to it. */
  versionId: string | null
  runId: string
  seen: FieldVersions
}

/** Writes what may be written; returns the fields that took the run's value, with their versions. */
export async function applySuggestions(
  tx: Tx,
  target: ApplyTarget,
  values: SuggestedValues,
): Promise<Map<string, number>> {
  const { modelId, itemId, versionId, runId, seen } = target
  await tx.execute(sql`
    SELECT 1 FROM content_items WHERE model_id = ${modelId}::uuid AND id = ${itemId}::uuid
       FOR UPDATE`)
  const applied = new Map<string, number>()
  const onItem = { modelId, itemId, versionId: null }
  for (const field of ['title', 'title_en', 'description'] as const) {
    const value = values[field]?.trim()
    if (!value) continue
    const version = await claimField(tx, onItem, field, seen[field] ?? 0, runId)
    if (version === null) continue
    const column = sql.identifier(field)
    await tx.execute(sql`
      UPDATE content_items SET ${column} = ${value}
       WHERE model_id = ${modelId}::uuid AND id = ${itemId}::uuid`)
    applied.set(field, version)
  }
  const tags = [...new Set((values.tags ?? []).map(tagSlug).filter((t): t is string => !!t))]
  const tagsVersion =
    tags.length > 0 ? await claimField(tx, onItem, 'tags', seen.tags ?? 0, runId) : null
  if (tagsVersion !== null) {
    const ids: string[] = []
    for (const slug of tags.slice(0, 12)) ids.push(await tagId(tx, modelId, slug))
    // The run's tags replace the earlier tags of the markup; a person's and the import's stay.
    await tx.execute(sql`
      DELETE FROM item_tags
       WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND source = 'ai'
         AND NOT (tag_id = ANY(${sql.param(ids)}::uuid[]))`)
    for (const id of ids) {
      await tx.execute(sql`
        INSERT INTO item_tags (model_id, item_id, tag_id, source)
        VALUES (${modelId}::uuid, ${itemId}::uuid, ${id}::uuid, 'ai')
        ON CONFLICT (model_id, item_id, tag_id) DO NOTHING`)
    }
    applied.set('tags', tagsVersion)
  }
  const segments = values.chronology ?? []
  if (versionId && segments.length > 0) {
    const onVersion = { modelId, itemId: null, versionId }
    const version = await claimField(tx, onVersion, 'chronology', seen.chronology ?? 0, runId)
    if (version !== null) {
      await tx.execute(sql`
        DELETE FROM chronology_entries
         WHERE model_id = ${modelId}::uuid AND asset_version_id = ${versionId}::uuid`)
      for (const segment of new Map(segments.map((s) => [s.atMs, s])).values()) {
        await tx.execute(sql`
          INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, text, source,
                                          run_id)
          VALUES (${modelId}::uuid, ${itemId}::uuid, ${versionId}::uuid, ${segment.atMs},
                  ${segment.text}, 'ai', ${runId}::uuid)`)
      }
      applied.set('chronology', version)
    }
  }
  const texts = values.platform_texts
  if (texts?.wall.trim() && texts.message.trim()) {
    const version = await claimTexts(tx, modelId, itemId, seen.platform_texts ?? 0, runId, texts)
    if (version !== null) applied.set('platform_texts', version)
  }
  if (applied.size > 0) {
    await tx.execute(sql`
      UPDATE content_items SET row_version = row_version + 1, updated_at = now()
       WHERE model_id = ${modelId}::uuid AND id = ${itemId}::uuid`)
  }
  return applied
}

/**
 * The two English texts of a PPV (`generic/en/1`, `/2`): both drafts, unchanged since the run.
 * Their versions are counted together: the sum is what the run saw and what it leaves.
 */
async function claimTexts(
  tx: Tx,
  modelId: string,
  itemId: string,
  seen: number,
  runId: string,
  texts: { wall: string; message: string },
): Promise<number | null> {
  const { rows } = await tx.execute<{
    variant_no: number
    value_version: number
    confirmed: boolean
  }>(sql`
    SELECT variant_no, value_version::int AS value_version,
           confirmed_value_version IS NOT DISTINCT FROM value_version AS confirmed
      FROM platform_texts
     WHERE model_id = ${modelId}::uuid AND item_id = ${itemId}::uuid AND platform = 'generic'
       AND account_id IS NULL AND locale = 'en' AND variant_no IN (1, 2)
       FOR UPDATE`)
  const now = rows.reduce((sum, row) => sum + row.value_version, 0)
  if (now !== seen || rows.some((row) => row.confirmed)) return null
  let total = 0
  for (const [index, body] of [texts.wall.trim(), texts.message.trim()].entries()) {
    const { rows: written } = await tx.execute<{ value_version: number }>(sql`
      INSERT INTO platform_texts (model_id, item_id, platform, locale, variant_no, body,
                                  value_version, source, run_id)
      VALUES (${modelId}::uuid, ${itemId}::uuid, 'generic', 'en', ${index + 1}, ${body}, 1, 'ai',
              ${runId}::uuid)
      ON CONFLICT ON CONSTRAINT platform_texts_variant DO UPDATE
         SET body = excluded.body, value_version = platform_texts.value_version + 1,
             source = 'ai', run_id = excluded.run_id, updated_at = now(), updated_by = NULL
      RETURNING value_version::int AS value_version`)
    total += written[0]?.value_version ?? 0
  }
  return total
}
