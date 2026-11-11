import { logAction, type Queryable, type Tx } from '@contentops/db'
import { contextOf } from '@contentops/legacy'
import { nfc, sourcePath } from '@contentops/sources'
import { type SQL, sql } from 'drizzle-orm'

/**
 * «Копии кастомов» (SPEC §6.2, решение владельца 11.11.2026). 10–11.11.2026 cuts of a fan's paid
 * custom stood on a model's wall: the model had put a copy of the custom, byte for byte, into
 * `2. FYP`. An alias of the custom does not catch every such copy: a file moved there takes a
 * second path without a draft, custom ↔ PPV gives an object of its own, and the holder of the
 * same bytes is one object only. So the signal goes by the bytes themselves: the SHA-256 of any
 * version of a live custom (source or master) seen at a cloud path outside the customs section
 * — a copy or a moved file, whichever came first. One per custom and path (`review_cases`,
 * kind `custom_copy`): a rescan raises nothing new, «Понятно» of the owner closes it for good.
 */

/** What to look at: the files just seen, the customs just accepted, or the whole model. */
export type CopyScope = { objects: readonly string[] } | { items: readonly string[] } | 'all'

interface SeenCopy extends Record<string, unknown> {
  custom_id: string
  custom: string
  object_id: string
  path: string
  root: string | null
  kind: 'yandex_disk' | 'dropbox'
  sha: string
}

/** A path of the customs section: `3. Customs/…`, `BG/3. Customs/…`, a timed name in `BG`. */
export function inCustoms(relative: string): boolean {
  const context = contextOf(relative, { isDir: false })
  return context.subArea === 'customs' || context.typeHint === 'CUS'
}

/** The bytes of the live customs of the model: every version of their files. */
const customBytes = (modelId: string, items: readonly string[] | null): SQL => sql`
  SELECT DISTINCT c.id AS custom_id, public_item_id(c.type, c.number) AS custom, b.sha
    FROM content_items c
    JOIN item_memberships m ON m.model_id = c.model_id AND m.item_id = c.id
                           AND m.kind = 'owned' AND m.removed_at IS NULL
    JOIN asset_versions v ON v.model_id = m.model_id AND v.asset_id = m.asset_id
    CROSS JOIN LATERAL (VALUES (v.source_sha256), (v.master_sha256)) AS b (sha)
   WHERE c.model_id = ${modelId}::uuid AND c.type = 'CUS' AND c.deleted_at IS NULL
     AND b.sha IS NOT NULL
     ${items ? sql`AND c.id = ANY(${sql.param([...items])}::uuid[])` : sql``}`

/** Cloud files of the model whose current bytes are those of a custom. */
async function seenCopies(q: Queryable, modelId: string, scope: CopyScope): Promise<SeenCopy[]> {
  const live = sql`
    o.gone_since IS NULL AND NOT o.is_dir
    AND s.kind IN ('yandex_disk', 'dropbox')`
  if (scope !== 'all' && 'objects' in scope) {
    // Files just seen: their current bytes against every custom.
    const { rows } = await q.execute<SeenCopy>(sql`
      WITH custom_bytes AS (${customBytes(modelId, null)}),
      seen AS (
        SELECT o.id AS object_id, o.current_path AS path, s.root_path AS root, s.kind, b.sha
          FROM source_objects o
          JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
          JOIN source_revisions r ON r.model_id = o.model_id AND r.id = o.current_revision_id
          CROSS JOIN LATERAL (VALUES (r.source_sha256), (r.remote_sha256)) AS b (sha)
         WHERE o.model_id = ${modelId}::uuid AND o.id = ANY(${sql.param([...scope.objects])}::uuid[])
           AND b.sha IS NOT NULL AND ${live}
      )
      SELECT DISTINCT ON (cb.custom_id, seen.object_id)
             cb.custom_id, cb.custom, seen.object_id, seen.path, seen.root, seen.kind,
             encode(cb.sha, 'hex') AS sha
        FROM seen JOIN custom_bytes cb ON cb.sha = seen.sha
       ORDER BY cb.custom_id, seen.object_id`)
    return rows
  }
  // Customs just accepted, or the whole model: their bytes into the revisions by the index.
  const items = scope === 'all' ? null : scope.items
  const { rows } = await q.execute<SeenCopy>(sql`
    WITH custom_bytes AS (${customBytes(modelId, items)}),
    hits AS (
      SELECT cb.custom_id, cb.custom, cb.sha, r.id AS revision_id, r.source_object_id
        FROM custom_bytes cb
        JOIN source_revisions r ON r.model_id = ${modelId}::uuid AND r.source_sha256 = cb.sha
      UNION
      SELECT cb.custom_id, cb.custom, cb.sha, r.id, r.source_object_id
        FROM custom_bytes cb
        JOIN source_revisions r ON r.model_id = ${modelId}::uuid AND r.remote_sha256 = cb.sha
    )
    SELECT DISTINCT ON (h.custom_id, o.id)
           h.custom_id, h.custom, o.id AS object_id, o.current_path AS path, s.root_path AS root,
           s.kind, encode(h.sha, 'hex') AS sha
      FROM hits h
      JOIN source_objects o ON o.model_id = ${modelId}::uuid AND o.id = h.source_object_id
                           AND o.current_revision_id = h.revision_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE ${live}
     ORDER BY h.custom_id, o.id`)
  return rows
}

/**
 * Raises the signal for every copy of a custom the scope finds outside the customs section;
 * gives the number of new ones. Idempotent: an open or dismissed signal of the same custom and
 * path stays as it is. Each new one is a journal row `draft.custom_copy` with the path.
 */
export async function raiseCustomCopies(
  tx: Tx,
  modelId: string,
  scope: CopyScope,
): Promise<{ found: number; raised: number }> {
  if (scope !== 'all' && ('objects' in scope ? scope.objects : scope.items).length === 0) {
    return { found: 0, raised: 0 }
  }
  const copies = (await seenCopies(tx, modelId, scope)).flatMap((copy) => {
    const relative = sourcePath(copy.path, copy.root ?? '').relative
    return inCustoms(relative) ? [] : [{ ...copy, relative }]
  })
  let raised = 0
  for (const copy of copies) {
    const key = `${copy.custom_id}:${nfc(copy.kind === 'dropbox' ? copy.path.toLowerCase() : copy.path)}`
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO review_cases (model_id, kind, dedup_key, item_id, source_object_id, blob_sha256,
                                details)
      VALUES (${modelId}::uuid, 'custom_copy', ${key}, ${copy.custom_id}::uuid,
              ${copy.object_id}::uuid, decode(${copy.sha}, 'hex'),
              ${JSON.stringify({ path: copy.path, relative: copy.relative, source: copy.kind })}::jsonb)
      ON CONFLICT (model_id, kind, dedup_key) DO NOTHING
      RETURNING id`)
    const id = rows[0]?.id
    if (!id) continue
    raised += 1
    await logAction(tx, {
      modelId,
      action: 'draft.custom_copy',
      subjectKind: 'review_cases',
      subjectId: id,
      subjectLabel: copy.custom,
      itemId: copy.custom_id,
      after: { Кастом: copy.custom, Где: copy.relative },
    })
  }
  return { found: copies.length, raised }
}
