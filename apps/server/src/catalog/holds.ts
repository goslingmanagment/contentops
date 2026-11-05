import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { lockPage } from '../hub/match/write'
import { standingEvidence } from '../plan/records'
import { type DbItemType, type ItemRow, publicIdOfRow } from './ids'

/**
 * What holds an object in place (SPEC §4.1): plan rows (cancelled ones too — they are history),
 * live deliveries of an order, references from promo collections and placements. A placement is
 * one of three kinds by the evidence standing on it:
 *
 * - a candidate of the history pass of Hub (`cand:hist:…`) and nothing else — it never holds:
 *   the command takes it back as the pass does (`retract`, `history_retract`) and frees the
 *   post; the next pass finds the files under their new number;
 * - a claim of an old name (`used2`, `✅ ЗАПОЩЕНО`, legacy import) — it says the content went
 *   out, so it follows the object to its new number (type change, merge); a removal it holds;
 * - anything else (an exact match, a person's decision, a plan row) — it holds a type change and
 *   a removal; a merge takes it along with the files.
 *
 * Every write here runs under the matching lock of the page (`lockPage`), taken before the rows
 * of the objects: the matcher and «Сверить» take the page first too, so they never deadlock.
 */

const HISTORY_KEY = 'cand:hist:'

export type PlacementKind = 'candidate' | 'claim' | 'confirmed'

export interface HeldPlacement {
  id: string
  accountId: string
  surfaceId: string
  manualKey: string | null
  kind: PlacementKind
  /** Standing candidates of the history pass on it: what a command takes back. */
  candidates: string[]
}

export interface Holds {
  plan: number
  deliveries: number
  promo: number
  placements: HeldPlacement[]
}

/**
 * The matching locks of the pages where the objects have placements, in one order. Called
 * before the objects are locked; a placement that appears on another page in between is
 * locked when it is read (`placementsOf`).
 */
export async function lockPagesOf(
  tx: Tx,
  model: ModelScope,
  itemIds: readonly string[],
): Promise<Set<string>> {
  const { rows } = await tx.execute<{ account_id: string }>(sql`
    SELECT DISTINCT account_id FROM placements
     WHERE model_id = ${model.id}::uuid AND item_id = ANY(${sql.param([...itemIds])}::uuid[])
     ORDER BY account_id`)
  const locked = new Set<string>()
  for (const row of rows) {
    await lockPage(tx, row.account_id)
    locked.add(row.account_id)
  }
  return locked
}

interface EvidenceRow extends Record<string, unknown> {
  id: string
  placement_id: string
  kind: string
  strength: string | null
  corrects_id: string | null
  payload: Record<string, unknown>
  dedup_key: string
}

/** The placements of an object with the kind each one is, under their row locks. */
async function placementsOf(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  pages: Set<string>,
): Promise<HeldPlacement[]> {
  const { rows: found } = await tx.execute<{ account_id: string }>(sql`
    SELECT DISTINCT account_id FROM placements
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid ORDER BY account_id`)
  for (const row of found) {
    if (pages.has(row.account_id)) continue
    await lockPage(tx, row.account_id)
    pages.add(row.account_id)
  }
  const { rows } = await tx.execute<{
    id: string
    account_id: string
    surface_id: string
    manual_key: string | null
    plan_row_id: string | null
  }>(sql`
    SELECT id, account_id, surface_id, manual_key, plan_row_id FROM placements
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid
     ORDER BY id
     FOR UPDATE`)
  if (rows.length === 0) return []
  const { rows: evidence } = await tx.execute<EvidenceRow>(sql`
    SELECT id, placement_id, kind, strength, corrects_id, payload, dedup_key
      FROM placement_evidence
     WHERE model_id = ${model.id}::uuid
       AND placement_id = ANY(${sql.param(rows.map((row) => row.id))}::uuid[])
     ORDER BY recorded_at, id`)
  const byPlacement = new Map<string, EvidenceRow[]>()
  for (const row of evidence) {
    byPlacement.set(row.placement_id, [...(byPlacement.get(row.placement_id) ?? []), row])
  }
  return rows.map((row) => {
    const standing = standingEvidence(byPlacement.get(row.id) ?? [])
    const candidates = standing.filter(
      (entry) => entry.kind === 'observed' && entry.dedup_key.startsWith(HISTORY_KEY),
    )
    const claims = standing.filter((entry) => entry.kind === 'legacy_claim')
    const other = standing.length - candidates.length - claims.length
    const kind: PlacementKind =
      row.plan_row_id !== null || other > 0
        ? 'confirmed'
        : claims.length > 0
          ? 'claim'
          : 'candidate'
    return {
      id: row.id,
      accountId: row.account_id,
      surfaceId: row.surface_id,
      manualKey: row.manual_key,
      kind,
      candidates: candidates.map((entry) => entry.id),
    }
  })
}

export async function holdsOf(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  pages: Set<string>,
): Promise<Holds> {
  const { rows } = await tx.execute<{ promo: number; plan: number; deliveries: number }>(sql`
    SELECT (SELECT count(DISTINCT ref.item_id)::int
              FROM item_memberships own
              JOIN item_memberships ref ON ref.model_id = own.model_id AND ref.asset_id = own.asset_id
                                       AND ref.kind = 'reference' AND ref.removed_at IS NULL
              JOIN content_items prm ON prm.model_id = ref.model_id AND prm.id = ref.item_id
                                    AND prm.deleted_at IS NULL
             WHERE own.model_id = ${model.id}::uuid AND own.item_id = ${item.id}::uuid
               AND own.kind = 'owned' AND own.removed_at IS NULL) AS promo,
           (SELECT count(*)::int FROM posting_plan_rows r
             WHERE r.model_id = ${model.id}::uuid AND r.item_id = ${item.id}::uuid) AS plan,
           (SELECT count(*)::int FROM custom_order_deliveries d
             WHERE d.model_id = ${model.id}::uuid AND d.item_id = ${item.id}::uuid
               AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r
                                WHERE r.model_id = d.model_id AND r.retracts_id = d.id))
             AS deliveries`)
  const counts = rows[0] ?? { promo: 0, plan: 0, deliveries: 0 }
  return { ...counts, placements: await placementsOf(tx, model, item, pages) }
}

/** What a command refuses for, by the kinds of placements it may not take along. */
export function refuseHeld(
  item: ItemRow,
  holds: Holds,
  what: string,
  options: { promo: boolean; kinds: readonly PlacementKind[] },
): void {
  const count = (kind: PlacementKind) =>
    options.kinds.includes(kind)
      ? holds.placements.filter((placement) => placement.kind === kind).length
      : 0
  const claims = count('claim')
  const placed = count('confirmed')
  const uses = [
    ...(options.promo && holds.promo > 0 ? [`в промо-подборках: ${holds.promo}`] : []),
    ...(holds.plan > 0 ? [`в плане: ${holds.plan}`] : []),
    ...(holds.deliveries > 0 ? [`сдач заказа: ${holds.deliveries}`] : []),
    ...(claims > 0
      ? [`отметок «выходило»: ${claims} — слейте его с объектом, куда они относятся`]
      : []),
    ...(placed > 0 ? [`размещений: ${placed}`] : []),
  ]
  if (uses.length === 0) return
  throw new ApiProblem('item_in_use', `${what} нельзя: ${publicIdOfRow(item)} ${uses.join(', ')}`, {
    uses,
  })
}

/**
 * Candidates of the history pass taken back as the pass takes back its own (`retract` with
 * `history_retract`): the post or the vault file is free again and keeps no object; the next
 * pass binds it to wherever the files are then.
 */
export async function releaseCandidates(
  tx: Tx,
  model: ModelScope,
  placements: readonly HeldPlacement[],
  actor: Actor,
  reason: string,
): Promise<number> {
  let taken = 0
  for (const placement of placements.filter((one) => one.kind === 'candidate')) {
    for (const evidenceId of placement.candidates) {
      await tx.execute(sql`
        INSERT INTO placement_evidence (model_id, placement_id, source, kind, strength, payload,
                                        recorded_by, corrects_id, dedup_key)
        VALUES (${model.id}::uuid, ${placement.id}::uuid, 'manual', 'retract', NULL,
                ${JSON.stringify({ kind: 'history_retract', by: 'catalog', reason })}::jsonb,
                ${actor.id}::uuid, ${evidenceId}::uuid, ${`retract:${evidenceId}`})
        ON CONFLICT ON CONSTRAINT placement_evidence_dedup DO NOTHING`)
      taken += 1
    }
    await tx.execute(sql`
      UPDATE placements SET item_id = NULL, item_type = NULL, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${placement.id}::uuid`)
  }
  return taken
}

/**
 * Placements follow the object to another one. A placement of a legacy claim is keyed by its
 * object and day (`legacy:<object>:<day>`, the history pass finds the claim by it): the key
 * follows too, unless the other object already has a claim of that page, surface and day.
 */
export async function movePlacements(
  tx: Tx,
  model: ModelScope,
  from: ItemRow,
  to: { id: string; type: DbItemType },
  placements: readonly HeldPlacement[],
): Promise<number> {
  const prefix = `legacy:${from.id}:`
  for (const placement of placements) {
    const key = placement.manualKey?.startsWith(prefix)
      ? `legacy:${to.id}:${placement.manualKey.slice(prefix.length)}`
      : null
    await tx.execute(sql`
      UPDATE placements p
         SET item_id = ${to.id}::uuid, item_type = ${to.type},
             manual_key = CASE
               WHEN ${key}::text IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM placements o
                  WHERE o.model_id = p.model_id AND o.surface_id = p.surface_id
                    AND o.manual_key = ${key}::text)
               THEN ${key}::text ELSE p.manual_key END,
             row_version = row_version + 1
       WHERE p.model_id = ${model.id}::uuid AND p.id = ${placement.id}::uuid`)
  }
  return placements.length
}
