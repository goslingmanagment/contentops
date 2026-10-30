import type { UploadKind } from '@contentops/contracts/commands/uploads'
import type { Queryable, Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { DbItemType } from '../catalog/ids'
import { publicIdOf } from '../catalog/ids'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { compositionOf, currentFiles, enqueueCopies, sealComposition } from '../plan/composition'
import { planWrite } from '../plan/writes'

/**
 * A montage uploaded for a plan row (SPEC §6.1, §7): the row «ждёт монтаж» keeps the expected
 * type and its sources; the uploaded file becomes the object (FYP or PPV, accepted «при
 * загрузке» with provenance `montage_from` its sources' object) or the teaser of the row's
 * PPV, and the row gets it explicitly — its composition is sealed from the new object. A row
 * that no longer waits (cancelled, already filled) is a question ◆ «Подставить монтаж в
 * строку?» in «Приехало» with the row as it was and as it is.
 */

export interface PlanRowState extends Record<string, unknown> {
  id: string
  item_id: string | null
  item_type: DbItemType | null
  item_number: number | null
  manifest_id: string | null
  expected_type: 'FYP' | 'PPV' | null
  expected_role: 'teaser' | null
  cancelled_at: string | null
  slot_date: string
  account: string
  surface: 'wall' | 'fyp' | 'story' | 'vault' | 'mass_dm'
  input_item_id: string | null
  input_title: string | null
}

export async function planRow(
  q: Queryable,
  model: ModelScope,
  rowId: string,
  lock = false,
): Promise<PlanRowState> {
  const { rows } = await q.execute<PlanRowState>(sql`
    SELECT r.id, r.item_id, i.type AS item_type, i.number AS item_number, r.manifest_id,
           r.expected_type, r.expected_role, r.cancelled_at, r.slot_date::text AS slot_date,
           a.code AS account, s.kind AS surface, im.origin_item_id AS input_item_id,
           src.title AS input_title
      FROM posting_plan_rows r
      JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
      JOIN surfaces s ON s.model_id = r.model_id AND s.id = r.surface_id
      LEFT JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
      LEFT JOIN asset_manifests im ON im.model_id = r.model_id AND im.id = r.input_manifest_id
      LEFT JOIN content_items src ON src.model_id = im.model_id AND src.id = im.origin_item_id
     WHERE r.model_id = ${model.id}::uuid AND r.id::text = ${rowId}
     ${lock ? sql`FOR UPDATE OF r` : sql``}`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такой строки плана нет')
  return row
}

/** The row still takes a montage: not cancelled, nothing in it, a file expected. */
export function rowWaits(row: PlanRowState): boolean {
  return (
    row.cancelled_at === null &&
    row.manifest_id === null &&
    (row.expected_type !== null || row.expected_role !== null)
  )
}

/** What the row expects to be uploaded (DESIGN §3.7: the upload window picks it). */
export function expectedKind(row: PlanRowState): UploadKind {
  if (row.expected_role === 'teaser') return 'teaser'
  return row.expected_type === 'PPV' ? 'master_version' : 'fyp_montage'
}

/** «ждёт монтаж фупа · 2026-11-02 · lora-1» — the row in words, for ◆ «было → стало». */
export function rowWords(row: PlanRowState, waiting = true): string {
  const what =
    row.expected_role === 'teaser'
      ? 'тизер'
      : row.expected_type === 'PPV'
        ? 'монтаж PPV'
        : 'монтаж фупа'
  if (waiting) return `ждёт ${what} · ${row.slot_date} · ${row.account}`
  if (row.cancelled_at) return `отменена · ${row.slot_date} · ${row.account}`
  if (row.item_type && row.item_number !== null) {
    return `уже стоит ${publicIdOf(row.item_type, row.item_number)} · ${row.slot_date} · ${row.account}`
  }
  return `${row.slot_date} · ${row.account}`
}

/** The new object is made from the row's sources (`montage_from`, SPEC §4). */
export async function montageFrom(
  tx: Tx,
  model: ModelScope,
  childItemId: string,
  parentItemId: string | null,
  actor: Actor,
): Promise<void> {
  if (!parentItemId) return
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    VALUES (${model.id}::uuid, 'montage_from', ${childItemId}::uuid, ${parentItemId}::uuid,
            'plan_row', ${actor.id}::uuid)
    ON CONFLICT DO NOTHING`)
}

/**
 * Puts the accepted object into the row (SPEC §7 «принятый монтаж подставляется в неё
 * явно»): a sealed composition for the row's surface, the copy for the platform queued. The
 * expected type and the sources stay on the row as its history.
 */
export async function substituteRow(
  tx: Tx,
  model: ModelScope,
  actor: Actor,
  rowId: string,
  itemId: string,
): Promise<void> {
  const row = await planRow(tx, model, rowId, true)
  if (row.cancelled_at) {
    throw new ApiProblem('row_cancelled', 'Строка отменена — монтаж остался в каталоге')
  }
  const { rows } = await tx.execute<{ type: DbItemType }>(sql`
    SELECT type FROM content_items WHERE model_id = ${model.id}::uuid AND id = ${itemId}::uuid`)
  const type = rows[0]?.type
  if (!type) throw new ApiProblem('not_found', 'Объекта нет')
  const composition = compositionOf(
    type,
    row.surface,
    await currentFiles(tx, model.id, itemId),
    null,
  )
  if (composition.length === 0) {
    throw new ApiProblem('accept_blocked', 'Нечего поставить в строку', { reason: 'no_files' })
  }
  const manifestId = await sealComposition(tx, model.id, itemId, composition, actor.id)
  // The plan's own checks apply (an OnlyFans row and the second person, schema §9.2).
  await planWrite(() =>
    tx.execute(sql`
      UPDATE posting_plan_rows
         SET item_id = ${itemId}::uuid, manifest_id = ${manifestId}::uuid,
             row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${rowId}::uuid`),
  )
  await enqueueCopies(tx, model.id, composition)
}
