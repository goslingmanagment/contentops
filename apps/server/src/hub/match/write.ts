import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { MatchSurface, Page } from './load'

/**
 * Writes of matching (schema §3.6, §9.2, §9.6): one placement per publication, page and surface;
 * evidence only inserted, keyed so that a repeat writes nothing; the match projection of the Hub
 * files. Every call runs inside the caller's transaction with the journal context.
 */

export type SurfaceSource = 'hub' | 'km_mark' | 'km' | 'plan' | 'import' | 'hub_hint'

/** The refs that make a placement one publication: a post, or a file in a named album. */
export type Refs =
  | { kind: 'post'; postRef: string }
  | { kind: 'vault'; albumRef: string; mediaRef: string }

export interface PlacementTarget {
  surface: MatchSurface
  surfaceSource: SurfaceSource
  refs: Refs | null
  itemId: string | null
  planRowId: string | null
  occurredAt: string | null
  origin: 'plan' | 'hub' | 'manual'
  outOfCatalog?: boolean
  createdBy?: string | null
}

/** The serialisation of every write of matching on a page: the matcher and «Сверить». */
export async function lockPage(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hub_match:${accountId}`}, 0))`,
  )
}

export async function surfaceIdOf(tx: Tx, page: Page, surface: MatchSurface): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM surfaces
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND kind = ${surface}`)
  const id = rows[0]?.id
  if (!id) throw new Error(`page ${page.accountCode} has no surface ${surface}`)
  return id
}

async function itemType(tx: Tx, page: Page, itemId: string | null): Promise<string | null> {
  if (!itemId) return null
  const { rows } = await tx.execute<{ type: string }>(sql`
    SELECT type FROM content_items WHERE model_id = ${page.modelId}::uuid AND id = ${itemId}::uuid`)
  return rows[0]?.type ?? null
}

function refsWhere(refs: Refs) {
  return refs.kind === 'post'
    ? sql`external_post_ref = ${refs.postRef}`
    : sql`external_album_ref = ${refs.albumRef} AND external_media_ref = ${refs.mediaRef}`
}

async function byRefs(tx: Tx, page: Page, surfaceId: string, refs: Refs) {
  const { rows } = await tx.execute<{
    id: string
    plan_row_id: string | null
    manual_key: string | null
  }>(sql`
    SELECT id, plan_row_id, manual_key FROM placements
     WHERE model_id = ${page.modelId}::uuid AND surface_id = ${surfaceId}::uuid AND ${refsWhere(refs)}`)
  return rows[0] ?? null
}

async function byKey(tx: Tx, page: Page, surfaceId: string, key: string) {
  const { rows } = await tx.execute<{
    id: string
    external_post_ref: string | null
    external_media_ref: string | null
  }>(sql`
    SELECT id, external_post_ref, external_media_ref FROM placements
     WHERE model_id = ${page.modelId}::uuid AND surface_id = ${surfaceId}::uuid
       AND manual_key = ${key}`)
  return rows[0] ?? null
}

async function hasEvidence(tx: Tx, page: Page, placementId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM placement_evidence
     WHERE model_id = ${page.modelId}::uuid AND placement_id = ${placementId}::uuid LIMIT 1`)
  return rows.length > 0
}

async function dropBare(tx: Tx, page: Page, placementId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM placement_assets
     WHERE model_id = ${page.modelId}::uuid AND placement_id = ${placementId}::uuid`)
  await tx.execute(sql`
    DELETE FROM placements WHERE model_id = ${page.modelId}::uuid AND id = ${placementId}::uuid`)
}

function refColumns(refs: Refs | null) {
  return {
    post: refs?.kind === 'post' ? refs.postRef : null,
    album: refs?.kind === 'vault' ? refs.albumRef : null,
    media: refs?.kind === 'vault' ? refs.mediaRef : null,
    occurrence: refs === null ? 'manual' : refs.kind === 'post' ? 'post' : 'vault_member',
  }
}

/** A KM's or a person's surface outranks a hint or the plan; Hub's proof outranks everything. */
const SOURCE_RANK: Record<SurfaceSource, number> = {
  hub_hint: 0,
  plan: 1,
  import: 2,
  km_mark: 3,
  km: 4,
  hub: 5,
}

/**
 * The placement of a plan row on its surface (`manual_key = row:<id>`, the same as a KM mark,
 * SPEC §5): candidates of the row live on it. With `refs` the link is certain (exact or a
 * confirmed pair): the external IDs go into the earlier placement — a KM mark, «Отметить и
 * подтвердить» — and a placement of the same publication made before the plan link is merged
 * into it when nothing else stands on the mark (SPEC §7: «не создают второе размещение»).
 */
export async function rowPlacement(
  tx: Tx,
  page: Page,
  row: { id: string; itemId: string; surfaceId: string; slotAt: string },
  target: Omit<PlacementTarget, 'surface' | 'planRowId' | 'itemId'>,
): Promise<string> {
  const key = `row:${row.id}`
  let mark = await byKey(tx, page, row.surfaceId, key)
  const found = target.refs ? await byRefs(tx, page, row.surfaceId, target.refs) : null
  if (mark && found && found.id !== mark.id) {
    if (
      !(await hasEvidence(tx, page, mark.id)) &&
      !mark.external_post_ref &&
      !mark.external_media_ref
    ) {
      await dropBare(tx, page, mark.id)
      mark = null
    } else {
      // Two placements of one row (a rare order of events): the found one is linked too.
      await tx.execute(sql`
        UPDATE placements SET plan_row_id = ${row.id}::uuid, item_id = coalesce(item_id, ${row.itemId}::uuid),
               item_type = coalesce(item_type, (SELECT type FROM content_items
                 WHERE model_id = ${page.modelId}::uuid AND id = ${row.itemId}::uuid)),
               out_of_catalog = false, row_version = row_version + 1
         WHERE model_id = ${page.modelId}::uuid AND id = ${found.id}::uuid
           AND (plan_row_id IS DISTINCT FROM ${row.id}::uuid OR item_id IS NULL)`)
      return found.id
    }
  }
  const refs = refColumns(target.refs)
  const type = await itemType(tx, page, row.itemId)
  if (found) {
    await tx.execute(sql`
      UPDATE placements
         SET plan_row_id = ${row.id}::uuid, manual_key = coalesce(manual_key, ${key}),
             item_id = ${row.itemId}::uuid, item_type = ${type}, out_of_catalog = false,
             planned_at = ${row.slotAt}::timestamptz, row_version = row_version + 1
       WHERE model_id = ${page.modelId}::uuid AND id = ${found.id}::uuid
         AND (plan_row_id IS DISTINCT FROM ${row.id}::uuid OR manual_key IS NULL
              OR item_id IS DISTINCT FROM ${row.itemId}::uuid)`)
    await raiseSurface(tx, page, found.id, target.surfaceSource)
    return found.id
  }
  if (mark) {
    if (target.refs && !mark.external_post_ref && !mark.external_media_ref) {
      await tx.execute(sql`
        UPDATE placements
           SET external_post_ref = ${refs.post}, external_album_ref = ${refs.album},
               external_media_ref = ${refs.media}, occurrence_kind = ${refs.occurrence},
               occurred_at = coalesce(${target.occurredAt}::timestamptz, occurred_at),
               occurred_source = CASE WHEN ${target.occurredAt}::timestamptz IS NULL
                                      THEN occurred_source ELSE 'hub' END,
               event_precision = CASE WHEN ${target.occurredAt}::timestamptz IS NULL
                                      THEN event_precision ELSE 'exact' END,
               row_version = row_version + 1
         WHERE model_id = ${page.modelId}::uuid AND id = ${mark.id}::uuid`)
    }
    await raiseSurface(tx, page, mark.id, target.surfaceSource)
    return mark.id
  }
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, external_post_ref,
                            external_album_ref, external_media_ref, manual_key, item_id, item_type,
                            plan_row_id, planned_at, occurred_at, event_precision, occurred_source,
                            surface_source, origin, created_by)
    VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, ${row.surfaceId}::uuid,
            ${refs.occurrence}, ${refs.post}, ${refs.album}, ${refs.media}, ${key},
            ${row.itemId}::uuid, ${type}, ${row.id}::uuid, ${row.slotAt}::timestamptz,
            ${target.occurredAt}::timestamptz, 'exact',
            ${target.occurredAt ? 'hub' : null}, ${target.surfaceSource}, ${target.origin},
            ${target.createdBy ?? null}::uuid)
    RETURNING id`)
  return (rows[0] as { id: string }).id
}

async function raiseSurface(tx: Tx, page: Page, id: string, source: SurfaceSource): Promise<void> {
  const better = (Object.entries(SOURCE_RANK) as [SurfaceSource, number][])
    .filter(([, rank]) => rank < SOURCE_RANK[source])
    .map(([name]) => name)
  if (better.length === 0) return
  await tx.execute(sql`
    UPDATE placements SET surface_source = ${source}, row_version = row_version + 1
     WHERE model_id = ${page.modelId}::uuid AND id = ${id}::uuid
       AND surface_source = ANY (${sql.param(better)}::text[])`)
}

/**
 * The placement of a publication without a plan row (SPEC §7 «Наблюдения без плана»): found by
 * its refs, created once; a later object binding writes into it.
 */
export async function publicationPlacement(
  tx: Tx,
  page: Page,
  target: PlacementTarget & { refs: Refs },
): Promise<string> {
  const surfaceId = await surfaceIdOf(tx, page, target.surface)
  const found = await byRefs(tx, page, surfaceId, target.refs)
  if (found) {
    if (target.itemId) {
      await tx.execute(sql`
        UPDATE placements SET item_id = ${target.itemId}::uuid,
               item_type = ${await itemType(tx, page, target.itemId)}, out_of_catalog = false,
               row_version = row_version + 1
         WHERE model_id = ${page.modelId}::uuid AND id = ${found.id}::uuid AND item_id IS NULL`)
    }
    await raiseSurface(tx, page, found.id, target.surfaceSource)
    return found.id
  }
  const refs = refColumns(target.refs)
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO placements (model_id, account_id, surface_id, occurrence_kind, external_post_ref,
                            external_album_ref, external_media_ref, item_id, item_type, plan_row_id,
                            occurred_at, event_precision, occurred_source, surface_source, origin,
                            out_of_catalog, created_by)
    VALUES (${page.modelId}::uuid, ${page.accountId}::uuid, ${surfaceId}::uuid, ${refs.occurrence},
            ${refs.post}, ${refs.album}, ${refs.media}, ${target.itemId}::uuid,
            ${await itemType(tx, page, target.itemId)}, ${target.planRowId}::uuid,
            ${target.occurredAt}::timestamptz, 'exact', ${target.occurredAt ? 'hub' : null},
            ${target.surfaceSource}, ${target.origin}, ${target.outOfCatalog ?? false},
            ${target.createdBy ?? null}::uuid)
    RETURNING id`)
  return (rows[0] as { id: string }).id
}

/**
 * The earlier placement without an external ID the same publication belongs to (SPEC §7): a
 * legacy claim of the object on the page and surface on the same day. Two such — none: the
 * person sorts them out in «Сверить».
 */
export async function claimPlacement(
  tx: Tx,
  page: Page,
  input: { itemId: string; surfaceId: string; day: string },
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM placements
     WHERE model_id = ${page.modelId}::uuid AND account_id = ${page.accountId}::uuid
       AND surface_id = ${input.surfaceId}::uuid AND item_id = ${input.itemId}::uuid
       AND manual_key = ${`legacy:${input.itemId}:${input.day}`}
       AND external_post_ref IS NULL AND external_media_ref IS NULL`)
  return rows.length === 1 ? (rows[0] as { id: string }).id : null
}

/** Writes the external IDs into a claim found to be this publication. */
export async function attachRefs(
  tx: Tx,
  page: Page,
  placementId: string,
  refs: Refs,
  occurredAt: string,
): Promise<void> {
  const columns = refColumns(refs)
  await tx.execute(sql`
    UPDATE placements
       SET external_post_ref = ${columns.post}, external_album_ref = ${columns.album},
           external_media_ref = ${columns.media}, occurrence_kind = ${columns.occurrence},
           occurred_at = ${occurredAt}::timestamptz, occurred_source = 'hub',
           event_precision = 'exact', row_version = row_version + 1
     WHERE model_id = ${page.modelId}::uuid AND id = ${placementId}::uuid
       AND external_post_ref IS NULL AND external_media_ref IS NULL`)
}

export interface EvidenceInput {
  placementId: string
  source: 'hub' | 'manual'
  kind:
    | 'observed'
    | 'manual_confirm'
    | 'reused_pair'
    | 'manual_reject'
    | 'outside_catalog'
    | 'retract'
  strength: 'candidate' | 'exact' | null
  observationId?: string | null
  externalRef?: string | null
  matchedAssetId?: string | null
  matchedVersionId?: string | null
  payload: Record<string, unknown>
  eventAt?: string | null
  recordedBy?: string | null
  correctsId?: string | null
  dedupKey: string
}

/** Inserts evidence once: the same key on the same placement is the same evidence. */
export async function addEvidence(
  tx: Tx,
  page: Page,
  input: EvidenceInput,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength,
                                    hub_observation_id, external_ref, matched_asset_id,
                                    matched_version_id, payload, event_at, recorded_by,
                                    corrects_id, dedup_key)
    VALUES (${page.modelId}::uuid, ${input.placementId}::uuid, ${input.source}, ${input.kind},
            ${input.strength}, ${input.observationId ?? null}::uuid, ${input.externalRef ?? null},
            ${input.matchedAssetId ?? null}::uuid, ${input.matchedVersionId ?? null}::uuid,
            ${JSON.stringify(input.payload)}::jsonb, ${input.eventAt ?? null}::timestamptz,
            ${input.recordedBy ?? null}::uuid, ${input.correctsId ?? null}::uuid, ${input.dedupKey})
    ON CONFLICT ON CONSTRAINT placement_evidence_dedup DO NOTHING
    RETURNING id`)
  return rows[0]?.id ?? null
}

/** The files of a placement by version with the platform file each one was matched to. */
export async function bindAssets(
  tx: Tx,
  page: Page,
  placementId: string,
  files: readonly {
    assetId: string
    versionId: string
    strength: 'candidate' | 'exact'
    mediaRef: string | null
    receiptEntryId?: string | null
  }[],
  by: string | null,
): Promise<void> {
  for (const file of files) {
    await tx.execute(sql`
      INSERT INTO placement_assets (model_id, placement_id, asset_id, asset_version_id, position,
                                    match_strength, matched_media_ref, receipt_entry_id, bound_by)
      VALUES (${page.modelId}::uuid, ${placementId}::uuid, ${file.assetId}::uuid,
              ${file.versionId}::uuid,
              (SELECT coalesce(max(position), 0) + 1 FROM placement_assets
                WHERE model_id = ${page.modelId}::uuid AND placement_id = ${placementId}::uuid),
              ${file.strength}, ${file.mediaRef}, ${file.receiptEntryId ?? null}::uuid, ${by}::uuid)
      ON CONFLICT (model_id, placement_id, asset_version_id) DO UPDATE
         SET match_strength = EXCLUDED.match_strength,
             matched_media_ref = coalesce(EXCLUDED.matched_media_ref, placement_assets.matched_media_ref),
             receipt_entry_id = coalesce(EXCLUDED.receipt_entry_id, placement_assets.receipt_entry_id)
       WHERE placement_assets.match_strength IS DISTINCT FROM EXCLUDED.match_strength
          OR placement_assets.matched_media_ref IS DISTINCT FROM
             coalesce(EXCLUDED.matched_media_ref, placement_assets.matched_media_ref)
          OR placement_assets.receipt_entry_id IS DISTINCT FROM
             coalesce(EXCLUDED.receipt_entry_id, placement_assets.receipt_entry_id)`)
  }
}

/** The match projection of an attachment (schema §9.6); a repeat changes nothing. */
export async function setProjection(
  tx: Tx,
  page: Page,
  attachmentId: string,
  match: { versionId: string | null; assetId: string | null; receiptEntryId: string | null },
): Promise<boolean> {
  const strength = match.versionId ? 'exact' : 'none'
  const result = await tx.execute(sql`
    UPDATE hub_post_attachments
       SET matched_asset_id = ${match.assetId}::uuid, matched_version_id = ${match.versionId}::uuid,
           receipt_entry_id = ${match.receiptEntryId}::uuid, match_strength = ${strength},
           matched_at = CASE WHEN ${match.versionId}::uuid IS NULL THEN NULL ELSE now() END
     WHERE model_id = ${page.modelId}::uuid AND id = ${attachmentId}::uuid
       AND (matched_version_id IS DISTINCT FROM ${match.versionId}::uuid
            OR receipt_entry_id IS DISTINCT FROM ${match.receiptEntryId}::uuid)`)
  return (result.rowCount ?? 0) > 0
}

/** Views and likes summed over the files of a placement; no row — «нет данных», not 0. */
export async function setStats(
  tx: Tx,
  page: Page,
  placementId: string,
  stats: { views: number | null; likes: number | null },
): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE placements
       SET views = ${stats.views}, likes = ${stats.likes},
           stats_at = CASE WHEN ${stats.views}::bigint IS NULL AND ${stats.likes}::bigint IS NULL
                           THEN NULL ELSE now() END,
           row_version = row_version + 1
     WHERE model_id = ${page.modelId}::uuid AND id = ${placementId}::uuid
       AND (views IS DISTINCT FROM ${stats.views}::bigint OR likes IS DISTINCT FROM ${stats.likes}::bigint)`)
  return (result.rowCount ?? 0) > 0
}
