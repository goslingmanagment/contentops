import { logAction, type Queryable, type Tx } from '@contentops/db'
import type { LegacyDate, UsagePayload } from '@contentops/legacy'
import { sql } from 'drizzle-orm'
import { labelTargets } from './labels'

/**
 * Claims of the old names become placements (SPEC §6.3): a `used*` / `posted` claim whose label
 * the КМ confirmed for a page, on a file or folder whose files are accepted, gives a placement
 * with evidence `import` of strength `claim` — one per object, page, surface and date; a claim
 * of newer rules adds its evidence to the same placement.
 *
 * The surface comes from the object's type (SPEC §7 «тип ставится только на свои
 * поверхности»): FYP — фуп, сет — стена, секстинг — vault, PPV-бандл — стена, PPV в личку —
 * vault. Лайф, кастом, сырьё and the rest have no single surface: their claims stay claims.
 * Stories and mass messages never come from names.
 */

export type SurfaceKind = 'wall' | 'fyp' | 'vault'

export function surfaceOfItem(type: string, ppvKind: string | null): SurfaceKind | null {
  if (type === 'FYP') return 'fyp'
  if (type === 'SET') return 'wall'
  if (type === 'SXT') return 'vault'
  if (type === 'PPV') return ppvKind === 'bundle' ? 'wall' : ppvKind === 'dm' ? 'vault' : null
  return null
}

/** A day of the claim when it has year, month and day; otherwise the date is unknown. */
export function dayOf(date: LegacyDate | null): string | null {
  return date && date.year !== null && date.day !== null ? date.iso : null
}

interface ClaimRow {
  id: string
  object_id: string
  is_dir: boolean
  path: string
  source_id: string
  raw_fragment: string
  payload: UsagePayload
}

interface LinkRow {
  claim_id: string
  item_id: string
  item_type: string
  ppv_kind: string | null
  asset_id: string
  version_id: string
}

export interface MaterializeResult {
  claims: number
  placements: number
  evidence: number
}

/**
 * Turns the open usage claims with a confirmed page into placements. `objectIds` narrows it to
 * the claims of these files and of the folders above them (after an acceptance); `labels` — to
 * the claims of these labels (after the КМ saved them).
 */
export async function materializeClaims(
  tx: Tx,
  modelId: string,
  actorId: string | null,
  scope: { objectIds?: readonly string[]; labels?: readonly string[] } = {},
): Promise<MaterializeResult> {
  const result: MaterializeResult = { claims: 0, placements: 0, evidence: 0 }
  const targets = await labelTargets(tx, modelId)
  const pages = new Map(
    [...targets].flatMap(([label, target]) =>
      target.kind === 'accounts' ? [[label, target.accounts] as const] : [],
    ),
  )
  const labels = [...pages.keys()].filter((label) => !scope.labels || scope.labels.includes(label))
  if (labels.length === 0) return result
  if (scope.objectIds && scope.objectIds.length === 0) return result

  const objects = scope.objectIds ? [...scope.objectIds] : null
  const { rows: claims } = await tx.execute<ClaimRow & Record<string, unknown>>(sql`
    SELECT c.id, o.id AS object_id, o.is_dir, o.current_path AS path, o.source_id,
           c.raw_fragment, c.payload
      FROM legacy_claims c
      JOIN source_objects o ON o.model_id = c.model_id AND o.id = c.source_object_id
     WHERE c.model_id = ${modelId}::uuid AND c.resolution = 'pending'
       AND c.claim_kind IN ('used', 'posted')
       AND c.payload ->> 'label' = ANY (${sql.param(labels)}::text[])
       AND (${objects === null}::boolean
            OR EXISTS (
              SELECT 1 FROM source_objects f
               WHERE f.model_id = o.model_id
                 AND f.id = ANY (${sql.param(objects ?? [])}::uuid[])
                 AND (f.id = o.id OR (o.is_dir AND starts_with(f.current_path, o.current_path || '/')))))
     ORDER BY c.id`)
  if (claims.length === 0) return result

  const links = await linkedFiles(tx, modelId, claims)
  const surfaces = await surfacesOf(tx, modelId)
  const { rows: model } = await tx.execute<{ timezone: string }>(sql`
    SELECT timezone FROM models WHERE id = ${modelId}::uuid`)
  const timezone = model[0]?.timezone ?? 'Europe/Moscow'

  for (const claim of claims) {
    const accounts = pages.get(claim.payload.label) ?? []
    const byItem = new Map<string, LinkRow[]>()
    for (const link of links.filter((row) => row.claim_id === claim.id)) {
      byItem.set(link.item_id, [...(byItem.get(link.item_id) ?? []), link])
    }
    const day = dayOf(claim.payload.date)
    const evidenceIds: string[] = []
    for (const [itemId, files] of byItem) {
      const first = files[0] as LinkRow
      const kind = surfaceOfItem(first.item_type, first.ppv_kind)
      if (!kind) continue
      for (const account of accounts) {
        const surface = surfaces.get(`${account}:${kind}`)
        if (!surface) continue
        const placement = await placementFor(tx, {
          modelId,
          accountId: surface.account_id,
          surfaceId: surface.id,
          itemId,
          itemType: first.item_type,
          day,
          timezone,
          actorId,
        })
        if (placement.created) result.placements += 1
        for (const file of files) {
          await tx.execute(sql`
            INSERT INTO placement_assets (model_id, placement_id, asset_id, asset_version_id,
                                          position, bound_by)
            VALUES (${modelId}::uuid, ${placement.id}::uuid, ${file.asset_id}::uuid,
                    ${file.version_id}::uuid,
                    (SELECT coalesce(max(position), 0) + 1 FROM placement_assets
                      WHERE model_id = ${modelId}::uuid AND placement_id = ${placement.id}::uuid),
                    ${actorId}::uuid)
            ON CONFLICT (model_id, placement_id, asset_version_id) DO NOTHING`)
        }
        const evidence = await tx.execute<{ id: string }>(sql`
          INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                          legacy_claim_id, payload, event_at, recorded_by,
                                          dedup_key)
          VALUES (${modelId}::uuid, ${placement.id}::uuid, 'import', 'legacy_claim', 'claim',
                  ${claim.id}::uuid,
                  ${JSON.stringify({
                    label: claim.payload.label,
                    fragment: claim.raw_fragment,
                    account_rule: claim.payload.account_rule,
                    post_of_day: claim.payload.post_of_day,
                  })}::jsonb,
                  ${day === null ? null : sql`(${day}::date)::timestamp AT TIME ZONE ${timezone}`},
                  ${actorId}::uuid, ${`claim:${claim.id}`})
          ON CONFLICT (model_id, placement_id, source, dedup_key) DO NOTHING
          RETURNING id`)
        const id = evidence.rows[0]?.id
        if (id) {
          result.evidence += 1
          evidenceIds.push(id)
        }
      }
    }
    if (evidenceIds.length === 0) continue
    await tx.execute(sql`
      UPDATE legacy_claims
         SET resolution = 'resolved', resolved_evidence_id = ${evidenceIds[0] as string}::uuid,
             resolved_at = now(), resolved_by = ${actorId}::uuid, row_version = row_version + 1
       WHERE model_id = ${modelId}::uuid AND id = ${claim.id}::uuid AND resolution = 'pending'`)
    result.claims += 1
  }
  if (result.claims > 0) {
    await logAction(tx, {
      modelId,
      action: 'legacy.placements',
      subjectKind: 'placements',
      subjectLabel: 'Заявки старых имён',
      after: {
        'Заявок стало размещениями': String(result.claims),
        'Новых размещений': String(result.placements),
      },
    })
  }
  return result
}

/** Accepted files of the claims: the file itself, or every file under the claimed folder. */
async function linkedFiles(
  q: Queryable,
  modelId: string,
  claims: readonly ClaimRow[],
): Promise<LinkRow[]> {
  const input = JSON.stringify(
    claims.map((claim) => ({
      claim_id: claim.id,
      object_id: claim.object_id,
      is_dir: claim.is_dir,
      path: claim.path,
      source_id: claim.source_id,
    })),
  )
  const { rows } = await q.execute<LinkRow & Record<string, unknown>>(sql`
    WITH claimed AS (
      SELECT * FROM jsonb_to_recordset(${input}::jsonb)
             AS x(claim_id uuid, object_id uuid, is_dir boolean, path text, source_id uuid)
    ), files AS (
      SELECT c.claim_id, f.id AS file_id
        FROM claimed c
        JOIN source_objects f ON f.model_id = ${modelId}::uuid AND f.source_id = c.source_id
         AND NOT f.is_dir
         AND (f.id = c.object_id OR (c.is_dir AND starts_with(f.current_path, c.path || '/')))
    ), versions AS (
      SELECT files.claim_id, v.asset_id, v.id AS version_id
        FROM files
        JOIN source_revisions r ON r.model_id = ${modelId}::uuid AND r.source_object_id = files.file_id
        JOIN asset_versions v ON v.model_id = r.model_id AND v.source_revision_id = r.id
      UNION
      SELECT files.claim_id, a.asset_id, s.current_version_id AS version_id
        FROM files
        JOIN aliases a ON a.model_id = ${modelId}::uuid AND a.source_object_id = files.file_id
         AND a.asset_id IS NOT NULL
        JOIN assets s ON s.model_id = a.model_id AND s.id = a.asset_id
       WHERE s.current_version_id IS NOT NULL
    )
    SELECT DISTINCT versions.claim_id, m.item_id, i.type AS item_type, i.ppv_kind,
           versions.asset_id, versions.version_id
      FROM versions
      JOIN item_memberships m ON m.model_id = ${modelId}::uuid AND m.asset_id = versions.asset_id
       AND m.kind = 'owned' AND m.removed_at IS NULL
      JOIN content_items i ON i.model_id = m.model_id AND i.id = m.item_id AND i.deleted_at IS NULL
     ORDER BY versions.claim_id, m.item_id, versions.version_id`)
  return rows
}

async function surfacesOf(q: Queryable, modelId: string) {
  const { rows } = await q.execute<{ id: string; account_id: string; code: string; kind: string }>(
    sql`
      SELECT s.id, s.account_id, a.code, s.kind FROM surfaces s
        JOIN accounts a ON a.model_id = s.model_id AND a.id = s.account_id
       WHERE s.model_id = ${modelId}::uuid AND a.archived_at IS NULL`,
  )
  return new Map(rows.map((row) => [`${row.code}:${row.kind}`, row]))
}

/** One placement per object, page, surface and date (`manual_key`), created at first need. */
async function placementFor(
  tx: Tx,
  input: {
    modelId: string
    accountId: string
    surfaceId: string
    itemId: string
    itemType: string
    day: string | null
    timezone: string
    actorId: string | null
  },
): Promise<{ id: string; created: boolean }> {
  const key = `legacy:${input.itemId}:${input.day ?? 'unknown'}`
  const occurred =
    input.day === null ? null : sql`(${input.day}::date)::timestamp AT TIME ZONE ${input.timezone}`
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, manual_key, item_id,
                            item_type, occurred_at, event_precision, occurred_source,
                            surface_source, origin, created_by)
    VALUES (${input.modelId}::uuid, ${input.accountId}::uuid, ${input.surfaceId}::uuid, 'manual',
            ${key}, ${input.itemId}::uuid, ${input.itemType}, ${occurred},
            ${input.day === null ? 'unknown' : 'day'}, ${input.day === null ? null : 'import'},
            'import', 'import', ${input.actorId}::uuid)
    ON CONFLICT (model_id, surface_id, manual_key) WHERE manual_key IS NOT NULL DO NOTHING
    RETURNING id`)
  const id = inserted.rows[0]?.id
  if (id) return { id, created: true }
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM placements
     WHERE model_id = ${input.modelId}::uuid AND surface_id = ${input.surfaceId}::uuid
       AND manual_key = ${key}`)
  return { id: (rows[0] as { id: string }).id, created: false }
}
