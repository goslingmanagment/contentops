import type { ThumbRef } from '@contentops/contracts/domain/common'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * Real thumbnails of the old corpus for «Разбор старого» (DESIGN §4.9): a person decides by
 * looking at them. A file shows its own `thumb-640.webp` — built from its source at the import,
 * or of the master it became; a folder shows its first file that has one (by path, the files
 * inside or one level deeper). Nothing built yet — `url: null`, the place stays grey.
 */
export async function legacyThumbs(
  q: Queryable,
  model: { id: string; code: string },
  objectIds: readonly string[],
): Promise<Map<string, ThumbRef>> {
  const ids = [...new Set(objectIds)]
  const out = new Map<string, ThumbRef>()
  for (const id of ids) out.set(id, { key: `legacy:${id}`, ratio: '3:4', url: null })
  if (ids.length === 0) return out
  const { rows } = await q.execute<{ id: string; generation: string }>(sql`
    WITH wanted AS (
      SELECT o.id, o.source_id, o.is_dir, o.current_path, o.current_revision_id
        FROM source_objects o
       WHERE o.model_id = ${model.id}::uuid AND o.id = ANY (${sql.param(ids)}::uuid[])
    ), files AS (
      SELECT f.source_id, f.current_path AS path, f.current_revision_id AS revision_id,
             regexp_replace(f.current_path, '/[^/]+$', '') AS parent,
             regexp_replace(f.current_path, '/[^/]+/[^/]+$', '') AS grandparent
        FROM source_objects f
       WHERE f.model_id = ${model.id}::uuid AND NOT f.is_dir
         AND f.source_id IN (SELECT source_id FROM wanted WHERE is_dir)
    ), candidates AS (
      SELECT w.id, w.current_path AS path, w.current_revision_id AS revision_id
        FROM wanted w WHERE NOT w.is_dir
      UNION ALL
      SELECT w.id, f.path, f.revision_id
        FROM wanted w JOIN files f ON f.source_id = w.source_id AND f.parent = w.current_path
       WHERE w.is_dir
      UNION ALL
      SELECT w.id, f.path, f.revision_id
        FROM wanted w JOIN files f ON f.source_id = w.source_id AND f.grandparent = w.current_path
       WHERE w.is_dir
    )
    SELECT DISTINCT ON (c.id) c.id, t.generation
      FROM candidates c
      JOIN source_revisions r ON r.model_id = ${model.id}::uuid AND r.id = c.revision_id
                             AND r.source_sha256 IS NOT NULL
      JOIN LATERAL (
        SELECT g.id AS generation FROM rendition_generations g
         WHERE g.input_sha256 = r.source_sha256 AND g.kind = 'thumb640' AND g.state = 'ready'
           AND NOT g.meta_stripped
        UNION ALL
        SELECT g.id FROM asset_versions v
          JOIN rendition_generations g ON g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640'
                                      AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped
         WHERE v.model_id = ${model.id}::uuid AND v.source_sha256 = r.source_sha256
        LIMIT 1
      ) t ON true
     ORDER BY c.id, c.path`)
  for (const row of rows) {
    out.set(row.id, {
      key: `legacy:${row.id}`,
      ratio: '3:4',
      url: `/api/v1/${model.code}/g/${row.generation}/thumb-640.webp`,
    })
  }
  return out
}
