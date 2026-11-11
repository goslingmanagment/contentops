import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * Objects «из кастома» (SPEC §7, решение владельца 11.11.2026): a custom itself; an object with
 * a custom among its ancestors by provenance — «PPV из кастома», a montage or a frame of it, at
 * any depth, through version links too; or one whose files hold the bytes of a custom (SHA-256
 * of the source or the master, any version) — a copy the model put elsewhere, and so whatever
 * was cut from that copy. A live custom only: a deleted one was not a custom. Suggested links
 * count until a person removes them: a wrong one says which custom it names.
 *
 * Gives each of `ids` that is, with the custom it comes from (`CUS-012`).
 */
export async function fromCustom(
  q: Queryable,
  modelId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (wanted.length === 0) return new Map()
  const { rows } = await q.execute<{ id: string; custom: string }>(sql`
    WITH RECURSIVE
      -- Provenance as links between objects: a version link goes to the objects owning the
      -- versions.
      edges AS (
        SELECT coalesce(p.child_item_id, cm.item_id) AS child,
               coalesce(p.parent_item_id, pm.item_id) AS parent
          FROM provenance p
          LEFT JOIN asset_versions cv ON cv.model_id = p.model_id AND cv.id = p.child_version_id
          LEFT JOIN item_memberships cm ON cm.model_id = cv.model_id AND cm.asset_id = cv.asset_id
                                       AND cm.kind = 'owned' AND cm.removed_at IS NULL
          LEFT JOIN asset_versions pv ON pv.model_id = p.model_id AND pv.id = p.parent_version_id
          LEFT JOIN item_memberships pm ON pm.model_id = pv.model_id AND pm.asset_id = pv.asset_id
                                       AND pm.kind = 'owned' AND pm.removed_at IS NULL
         WHERE p.model_id = ${modelId}::uuid AND p.voided_by_id IS NULL
      ),
      up (root, id, depth) AS (
        SELECT t.id, t.id, 0 FROM unnest(${sql.param(wanted)}::uuid[]) AS t (id)
        UNION
        SELECT up.root, e.parent, up.depth + 1
          FROM up JOIN edges e ON e.child = up.id
         WHERE e.parent IS NOT NULL AND e.parent <> up.id AND up.depth < 16
      ),
      customs AS (
        SELECT c.id, public_item_id(c.type, c.number) AS public_id
          FROM content_items c
         WHERE c.model_id = ${modelId}::uuid AND c.type = 'CUS' AND c.deleted_at IS NULL
      ),
      custom_bytes AS (
        SELECT DISTINCT cu.public_id, b.sha
          FROM customs cu
          JOIN item_memberships m ON m.model_id = ${modelId}::uuid AND m.item_id = cu.id
                                 AND m.kind = 'owned' AND m.removed_at IS NULL
          JOIN asset_versions v ON v.model_id = m.model_id AND v.asset_id = m.asset_id
          CROSS JOIN LATERAL (VALUES (v.master_sha256), (v.source_sha256)) AS b (sha)
         WHERE b.sha IS NOT NULL
      )
    SELECT DISTINCT ON (up.root) up.root AS id, coalesce(direct.public_id, shared.public_id) AS custom
      FROM up
      LEFT JOIN customs direct ON direct.id = up.id
      LEFT JOIN LATERAL (
        SELECT cb.public_id
          FROM item_memberships m
          JOIN asset_versions v ON v.model_id = m.model_id AND v.asset_id = m.asset_id
          JOIN custom_bytes cb ON cb.sha = v.master_sha256 OR cb.sha = v.source_sha256
         WHERE m.model_id = ${modelId}::uuid AND m.item_id = up.id
           AND m.kind = 'owned' AND m.removed_at IS NULL
         ORDER BY cb.public_id
         LIMIT 1
      ) shared ON direct.id IS NULL
     WHERE direct.id IS NOT NULL OR shared.public_id IS NOT NULL
     ORDER BY up.root, up.depth, custom`)
  return new Map(rows.map((row) => [row.id, row.custom]))
}
