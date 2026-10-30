import type { Queryable, Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { ApiProblem } from '../errors'

/**
 * A processed frame of a set (SPEC §6.1): it is bound to its source frame by the name the
 * source was downloaded under — the receipt of that download (naming §6). The extension may
 * change on export (`.heic` → `.jpg`), so the name is compared without it, case and NFC
 * ignored. A name that is not known waits in «Приехало» as ◆ «К какому кадру?», with the
 * frames of the set similar by pHash first.
 */

export interface FrameMatch {
  ordinal: number
  versionId: string
}

const stemOf = (name: string) => {
  const base = name
    .slice(name.lastIndexOf('/') + 1)
    .normalize('NFC')
    .toLowerCase()
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** The source frame (`raw07` of the set) a file name was issued as, or `null`. */
export async function frameByDownloadName(
  q: Queryable,
  modelId: string,
  setItemId: string,
  fileName: string,
): Promise<FrameMatch | null> {
  const { rows } = await q.execute<{ ordinal: number; version_id: string }>(sql`
    SELECT m.ordinal, a.current_version_id AS version_id
      FROM download_receipt_entries e
      JOIN item_memberships m ON m.model_id = e.model_id AND m.asset_id = e.asset_id
                             AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
     WHERE e.model_id = ${modelId}::uuid AND m.item_id = ${setItemId}::uuid AND m.role = 'raw'
       AND regexp_replace(e.file_name_norm, '\\.[^./]+$', '') = ${stemOf(fileName)}
     ORDER BY e.receipt_id DESC LIMIT 1`)
  const row = rows[0]
  return row ? { ordinal: row.ordinal, versionId: row.version_id } : null
}

/** The current version of a source frame `raw<ordinal>` of the set. */
export async function rawFrame(
  q: Queryable,
  modelId: string,
  setItemId: string,
  ordinal: number,
): Promise<string | null> {
  const { rows } = await q.execute<{ version_id: string }>(sql`
    SELECT a.current_version_id AS version_id FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
     WHERE m.model_id = ${modelId}::uuid AND m.item_id = ${setItemId}::uuid AND m.kind = 'owned'
       AND m.role = 'raw' AND m.ordinal = ${ordinal} AND m.removed_at IS NULL`)
  return rows[0]?.version_id ?? null
}

/** `raw07` → 7. */
export function ordinalOfHandle(handle: string): number {
  const match = /^raw(\d{1,3})$/.exec(handle)
  if (!match) throw new ApiProblem('invalid_request', 'Такого кадра в сете нет', { frame: handle })
  return Number(match[1])
}

export interface FrameChoice {
  key: string
  label: string
  thumb: { key: string; ratio: '3:4'; url: string | null }
  similar: boolean
}

/**
 * The frames of the set for ◆ «К какому кадру?»: closest by pHash first (no merge, only the
 * order; «похоже» only within `phash_suggest_threshold` when the owner has set it).
 */
export async function frameChoices(
  q: Queryable,
  model: { id: string; code: string },
  setItemId: string,
  draftSha: Buffer | null,
): Promise<FrameChoice[]> {
  const { rows: limit } = await q.execute<{ value: unknown }>(sql`
    SELECT value FROM policy_settings
     WHERE key = 'phash_suggest_threshold' AND account_id IS NULL AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${model.id}::uuid) AND value IS NOT NULL
     ORDER BY model_id NULLS LAST LIMIT 1`)
  const threshold = Number(limit[0]?.value)
  const { rows } = await q.execute<{
    ordinal: number
    generation: string | null
    distance: number | null
  }>(sql`
    SELECT m.ordinal,
           (SELECT g.id FROM rendition_generations g
             WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
               AND g.state = 'ready' AND NOT g.meta_stripped
             ORDER BY g.ready_at DESC LIMIT 1) AS generation,
           (SELECT min(bit_count(p.phash # mine.phash)) FROM blob_phashes p
              JOIN blob_phashes mine ON mine.sha256 = ${draftSha}
                                    AND mine.algorithm = p.algorithm
                                    AND mine.algo_version = p.algo_version
                                    AND mine.normalization = p.normalization
             WHERE p.sha256 = v.master_sha256)::int AS distance
      FROM item_memberships m
      JOIN assets a ON a.model_id = m.model_id AND a.id = m.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
     WHERE m.model_id = ${model.id}::uuid AND m.item_id = ${setItemId}::uuid AND m.kind = 'owned'
       AND m.role = 'raw' AND m.removed_at IS NULL
     ORDER BY distance NULLS LAST, m.ordinal`)
  return rows.map((row) => {
    const key = `raw${String(row.ordinal).padStart(2, '0')}`
    return {
      key,
      label: `кадр ${row.ordinal}`,
      thumb: {
        key: `frame:${setItemId}:${key}`,
        ratio: '3:4',
        url: row.generation ? `/api/v1/${model.code}/g/${row.generation}/thumb-640.webp` : null,
      },
      similar: Number.isFinite(threshold) && row.distance !== null && row.distance <= threshold,
    }
  })
}

/** Marks a draft as the processed version of frame `ordinal`: role `ed` with that number. */
export async function bindFrame(tx: Tx, modelId: string, draftId: string, ordinal: number) {
  await tx.execute(sql`
    UPDATE inbox_drafts
       SET proposed_role = 'ed', proposed_ordinal = ${ordinal},
           blocked_reason = CASE WHEN blocked_reason = 'which_frame' THEN NULL ELSE blocked_reason END,
           updated_at = now(), row_version = row_version + 1
     WHERE model_id = ${modelId}::uuid AND id = ${draftId}::uuid`)
}
