import { ITEM_TYPE_INFO, type ItemId, type ItemType } from '@contentops/contracts/domain/item-type'
import { setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { handleOf, type MembershipRow, memberships } from './detail'
import { type DbItemType, dbType, type ItemRow, publicIdOf, publicIdOfRow } from './ids'
import { issueNumber } from './numbers'
import { checkItemVersion, lockItems, logItemAction, touchItem } from './writes'

/**
 * Changes of the catalog's structure (SPEC §4.1, §6.3, schema §3.2, «Слияние и разделение
 * пачек RAW»): a type change is a new object with a new number, the files move and the old
 * ID becomes an alias; a removal is a tombstone that can be taken back; RAW batches merge
 * (the lower number stays, the other ID becomes an alias) and split (the picked files get a
 * new number). One command, one transaction; versions are never created or changed, the old
 * sub-handles stay as aliases (`RAW-0035/raw03`).
 */

/** What holds an object in place: promo references now; plan rows, placements and order
 * deliveries join with their stages (3, 4а, 2в). */
async function usesOf(tx: Tx, model: ModelScope, item: ItemRow): Promise<string[]> {
  const { rows } = await tx.execute<{ promo: number }>(sql`
    SELECT count(DISTINCT ref.item_id)::int AS promo
      FROM item_memberships own
      JOIN item_memberships ref ON ref.model_id = own.model_id AND ref.asset_id = own.asset_id
                               AND ref.kind = 'reference' AND ref.removed_at IS NULL
     WHERE own.model_id = ${model.id}::uuid AND own.item_id = ${item.id}::uuid
       AND own.kind = 'owned' AND own.removed_at IS NULL`)
  const promo = rows[0]?.promo ?? 0
  return promo > 0 ? [`в промо-подборках: ${promo}`] : []
}

async function requireUnused(tx: Tx, model: ModelScope, item: ItemRow, what: string) {
  const uses = await usesOf(tx, model, item)
  if (uses.length > 0) {
    throw new ApiProblem(
      'item_in_use',
      `${what} нельзя: ${publicIdOfRow(item)} ${uses.join(', ')}`,
      {
        uses,
      },
    )
  }
}

type Role = MembershipRow['role']

/** The role a file takes in an object of the new type; `null` — it has no place there. */
function roleIn(type: DbItemType, row: MembershipRow, masterTaken: boolean): Role | null {
  const video = row.media_kind === 'video'
  switch (type) {
    case 'PPV':
      if (row.role === 'teaser') return 'teaser'
      if (video) return masterTaken ? null : 'master'
      return 'pic'
    case 'CUS':
      if (video) return masterTaken ? null : 'master'
      return 'pic'
    case 'FYP':
      return video && !masterTaken ? 'master' : null
    case 'SET':
      if (video) return null
      return row.role === 'ed' ? 'ed' : 'raw'
    case 'SXT':
    case 'LIFE':
      return video ? 'clip' : 'pic'
    case 'RAW':
      return 'raw'
    default:
      return null
  }
}

const ORDINAL_ROLES = new Set<Role>(['pic', 'raw', 'ed', 'clip'])

/**
 * Moves owned files to another object: the old membership closes, the old handle becomes an
 * alias of the file, the new one takes the next free number of its role (handles are never
 * reused, removed ones count too).
 */
async function moveFiles(
  tx: Tx,
  model: ModelScope,
  from: ItemRow,
  to: { id: string; type: DbItemType; publicId: ItemId },
  rows: readonly MembershipRow[],
  roles: readonly Role[],
  actor: Actor,
) {
  const { rows: taken } = await tx.execute<{ role: Role; top: number }>(sql`
    SELECT role, coalesce(max(ordinal), 0)::int AS top FROM item_memberships
     WHERE model_id = ${model.id}::uuid AND item_id = ${to.id}::uuid AND kind = 'owned'
     GROUP BY role`)
  const next = new Map(taken.map((row) => [row.role, row.top]))
  const { rows: positions } = await tx.execute<{ position: number }>(sql`
    SELECT coalesce(max(display_position), 0)::int AS position FROM item_memberships
     WHERE model_id = ${model.id}::uuid AND item_id = ${to.id}::uuid`)
  let position = positions[0]?.position ?? 0
  const fromId = publicIdOfRow(from)
  for (const [index, row] of rows.entries()) {
    const role = roles[index] as Role
    await tx.execute(sql`
      UPDATE item_memberships
         SET removed_at = now(), display_position = NULL, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
    await tx.execute(sql`
      INSERT INTO aliases (model_id, kind, value_raw, asset_id, created_by)
      VALUES (${model.id}::uuid, 'sub_handle',
              ${`${fromId}/${handleOf(row.role, row.ordinal, row.variant_no)}`},
              ${row.asset_id}::uuid, ${actor.id}::uuid)
      ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
    let ordinal: number | null = null
    if (ORDINAL_ROLES.has(role)) {
      ordinal = (next.get(role) ?? 0) + 1
      next.set(role, ordinal)
    }
    position += 1
    await tx.execute(sql`
      INSERT INTO item_memberships (model_id, item_id, item_type, asset_id, variant_no, kind, role,
                                    ordinal, display_position, selected, life_use, added_by)
      VALUES (${model.id}::uuid, ${to.id}::uuid, ${to.type}, ${row.asset_id}::uuid,
              ${to.type === 'FYP' ? row.variant_no : 0}, 'owned', ${role}, ${ordinal}, ${position},
              ${to.type === 'SET' && row.selected}, ${to.type === 'LIFE' ? row.life_use : null},
              ${actor.id}::uuid)`)
  }
}

/** A new object of the model with the next number of its type (legacy pass required). */
async function newItem(
  tx: Tx,
  model: ModelScope,
  type: DbItemType,
  source: ItemRow,
  actor: Actor,
): Promise<{ id: string; type: DbItemType; number: number; publicId: ItemId }> {
  const number = await issueNumber(tx, model.id, type)
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO content_items (model_id, type, number, title, title_en, description, ppv_kind,
                               raw_purpose, shot_on, has_second_person, name_in_media, origin,
                               created_by)
    SELECT model_id, ${type}, ${number}, title, title_en, description,
           ${type === 'PPV' ? sql`coalesce(ppv_kind, 'bundle')` : sql`NULL`},
           ${type === 'RAW' ? sql`coalesce(raw_purpose, 'unknown')` : sql`NULL`},
           shot_on, has_second_person, ${type === 'CUS' ? sql`name_in_media` : sql`NULL`},
           'manual', ${actor.id}::uuid
      FROM content_items WHERE model_id = ${model.id}::uuid AND id = ${source.id}::uuid
    RETURNING id`)
  const id = rows[0]?.id
  if (!id) throw new Error('new item insert returned nothing')
  return { id, type, number, publicId: publicIdOf(type, number) }
}

/** Tags, item-level markup states and aliases follow the object to its new number. */
async function carryOver(tx: Tx, model: ModelScope, from: ItemRow, toId: string) {
  await tx.execute(sql`
    INSERT INTO item_tags (model_id, item_id, tag_id, source, group_at_import, added_by)
    SELECT model_id, ${toId}::uuid, tag_id, source, group_at_import, added_by FROM item_tags
     WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    ON CONFLICT (model_id, item_id, tag_id) DO NOTHING`)
  await tx.execute(sql`
    INSERT INTO annotation_fields (model_id, item_id, field, value_version,
                                   confirmed_value_version, confirmed_at, confirmed_by, updated_by)
    SELECT model_id, ${toId}::uuid, field, value_version, confirmed_value_version, confirmed_at,
           confirmed_by, updated_by
      FROM annotation_fields WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    ON CONFLICT ON CONSTRAINT annotation_fields_target DO NOTHING`)
  await tx.execute(sql`
    INSERT INTO aliases (model_id, kind, value_raw, item_id, source_object_id, note, created_by)
    SELECT model_id, kind, value_raw, ${toId}::uuid, source_object_id, note, created_by
      FROM aliases WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
  await tx.execute(sql`
    INSERT INTO aliases (model_id, kind, value_raw, item_id)
    VALUES (${model.id}::uuid, 'merged_id', ${publicIdOfRow(from)}, ${toId}::uuid)
    ON CONFLICT ON CONSTRAINT aliases_value DO NOTHING`)
}

/** Links of the old object are drawn again for the new one (provenance ends never change). */
async function carryLinks(tx: Tx, model: ModelScope, from: ItemRow, toId: string) {
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    SELECT model_id, relation,
           CASE WHEN child_item_id = ${from.id}::uuid THEN ${toId}::uuid ELSE child_item_id END,
           CASE WHEN parent_item_id = ${from.id}::uuid THEN ${toId}::uuid ELSE parent_item_id END,
           basis, created_by
      FROM provenance
     WHERE model_id = ${model.id}::uuid AND voided_by_id IS NULL
       AND (child_item_id = ${from.id}::uuid OR parent_item_id = ${from.id}::uuid)
       AND NOT (child_item_id = ${toId}::uuid OR parent_item_id = ${toId}::uuid)
    ON CONFLICT ON CONSTRAINT provenance_link DO NOTHING`)
}

/** Chronology of the moved versions goes with them (`item_id` is fixed: delete and re-insert). */
async function carryChronology(tx: Tx, model: ModelScope, from: ItemRow, toId: string) {
  const { rows } = await tx.execute<{
    asset_version_id: string
    at_ms: string
    end_ms: string | null
    text: string
    source: string
    created_by: string | null
  }>(sql`
    DELETE FROM chronology_entries WHERE model_id = ${model.id}::uuid AND item_id = ${from.id}::uuid
    RETURNING asset_version_id, at_ms::text, end_ms::text, text, source, created_by`)
  for (const entry of rows) {
    await tx.execute(sql`
      INSERT INTO chronology_entries (model_id, item_id, asset_version_id, at_ms, end_ms, text,
                                      source, created_by)
      VALUES (${model.id}::uuid, ${toId}::uuid, ${entry.asset_version_id}::uuid,
              ${entry.at_ms}::bigint, ${entry.end_ms}::bigint, ${entry.text}, ${entry.source},
              ${entry.created_by}::uuid)`)
  }
}

async function tombstone(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  actor: Actor,
  into: string | null,
) {
  await tx.execute(sql`
    UPDATE content_items
       SET deleted_at = now(), deleted_by = ${actor.id}::uuid, merged_into_item_id = ${into}::uuid,
           row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
}

/** «Сменить тип»: a new object with a new number; files, fields and links move. */
export async function changeType(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  type: ItemType,
  actor: Actor,
): Promise<ItemId> {
  const target = dbType(type)
  if (target === item.type) throw new ApiProblem('invalid_request', 'Тип уже такой')
  if (target === 'PRM' || item.type === 'PRM') {
    throw new ApiProblem('invalid_request', 'Промо-подборка не меняет тип и не становится другим')
  }
  await requireUnused(tx, model, item, 'Сменить тип')
  const rows = (await memberships(tx, model, [item.id])).filter((row) => row.kind === 'owned')
  const ordered = [...rows].sort((left, right) =>
    left.role === 'master' ? -1 : right.role === 'master' ? 1 : 0,
  )
  let masterTaken = false
  const roles: Role[] = []
  const homeless: string[] = []
  for (const row of ordered) {
    const role = row.variant_no > 0 ? null : roleIn(target, row, masterTaken)
    if (role === 'master') masterTaken = true
    if (role === null) homeless.push(handleOf(row.role, row.ordinal, row.variant_no))
    else roles.push(role)
  }
  if (homeless.length > 0) {
    throw new ApiProblem(
      'invalid_request',
      `В ${ITEM_TYPE_INFO[type].folder} не встанут файлы: ${homeless.join(', ')}`,
      { keys: homeless },
    )
  }
  const created = await newItem(tx, model, target, item, actor)
  await setJournalItem(tx, created.id)
  await moveFiles(tx, model, item, created, ordered, roles, actor)
  await carryOver(tx, model, item, created.id)
  await carryLinks(tx, model, item, created.id)
  await carryChronology(tx, model, item, created.id)
  await logItemAction(tx, model, created, {
    subject: `${publicIdOfRow(item)} → ${created.publicId}`,
  })
  await setJournalItem(tx, item.id)
  await tombstone(tx, model, item, actor, created.id)
  await logItemAction(tx, model, item, {
    subject: `${publicIdOfRow(item)} → ${created.publicId}`,
  })
  return created.publicId
}

/** «Удалить»: a tombstone; the number, files and links stay for «Вернуть». */
export async function removeItem(tx: Tx, model: ModelScope, item: ItemRow, actor: Actor) {
  await requireUnused(tx, model, item, 'Удалить')
  await tombstone(tx, model, item, actor, null)
  await logItemAction(tx, model, item, { subject: `${publicIdOfRow(item)} «${item.title ?? ''}»` })
}

/** «Вернуть» a deleted object (not a merged one): the tombstone goes, the number is the same. */
export async function restoreItem(tx: Tx, model: ModelScope, item: ItemRow) {
  if (!item.deleted_at) throw new ApiProblem('invalid_request', 'Объект не удалён')
  if (item.merged_into_item_id) {
    throw new ApiProblem('invalid_request', 'Слитый объект не возвращается — он живёт в другом')
  }
  await tx.execute(sql`
    UPDATE content_items
       SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
           row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
  await logItemAction(tx, model, item, { subject: publicIdOfRow(item) })
}

function requireRaw(item: ItemRow) {
  if (item.type !== 'RAW') throw new ApiProblem('invalid_request', 'Это можно только у сырья')
}

/**
 * «Слить с…»: two RAW batches become one; the lower number stays, the other is a tombstone
 * with its ID as an alias, its files move with new handles and the old ones as aliases.
 */
export async function mergeRaw(
  tx: Tx,
  model: ModelScope,
  id: string,
  into: string,
  ctx: RequestContext,
  actor: Actor,
): Promise<ItemId> {
  const locked = await lockItems(tx, model, [id, into])
  const self = locked.get(id)
  const other = locked.get(into)
  if (!self || !other) throw new Error('locked items vanished')
  await checkItemVersion(tx, ctx, self)
  requireRaw(self)
  requireRaw(other)
  if (self.id === other.id)
    throw new ApiProblem('invalid_request', 'Съёмка не сливается сама с собой')
  const [survivor, loser] = self.number < other.number ? [self, other] : [other, self]
  const rows = (await memberships(tx, model, [loser.id])).filter((row) => row.kind === 'owned')
  await setJournalItem(tx, survivor.id)
  await moveFiles(
    tx,
    model,
    loser,
    { id: survivor.id, type: 'RAW', publicId: publicIdOfRow(survivor) },
    rows,
    rows.map(() => 'raw'),
    actor,
  )
  await carryOver(tx, model, loser, survivor.id)
  await carryLinks(tx, model, loser, survivor.id)
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    VALUES (${model.id}::uuid, 'merged_from', ${survivor.id}::uuid, ${loser.id}::uuid, 'manual',
            ${actor.id}::uuid)
    ON CONFLICT ON CONSTRAINT provenance_link DO NOTHING`)
  await touchItem(tx, model, survivor)
  const words = `${publicIdOfRow(loser)} → ${publicIdOfRow(survivor)}`
  await logItemAction(tx, model, survivor, { subject: words })
  await setJournalItem(tx, loser.id)
  await tombstone(tx, model, loser, actor, survivor.id)
  await logItemAction(tx, model, loser, { subject: words })
  return publicIdOfRow(survivor)
}

/** «Выделить в новую съёмку»: the picked files of a RAW batch get a new number. */
export async function extractShoot(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: readonly string[],
  actor: Actor,
): Promise<ItemId> {
  requireRaw(item)
  const all = (await memberships(tx, model, [item.id])).filter((row) => row.kind === 'owned')
  const byKey = new Map(all.map((row) => [handleOf(row.role, row.ordinal, row.variant_no), row]))
  const unknown = keys.filter((key) => !byKey.has(key))
  if (unknown.length > 0) {
    throw new ApiProblem('invalid_request', 'Таких файлов в объекте нет', { keys: unknown })
  }
  const picked = [...new Set(keys)].map((key) => byKey.get(key) as MembershipRow)
  if (picked.length === all.length) {
    throw new ApiProblem(
      'invalid_request',
      'Все файлы сразу не выделяются — останется пустая съёмка',
    )
  }
  const created = await newItem(tx, model, 'RAW', item, actor)
  await setJournalItem(tx, created.id)
  await moveFiles(
    tx,
    model,
    item,
    created,
    picked,
    picked.map(() => 'raw'),
    actor,
  )
  await tx.execute(sql`
    INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
    VALUES (${model.id}::uuid, 'split_from', ${created.id}::uuid, ${item.id}::uuid, 'manual',
            ${actor.id}::uuid)`)
  const words = `${created.publicId} из ${publicIdOfRow(item)}`
  await logItemAction(tx, model, created, { subject: words })
  await setJournalItem(tx, item.id)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, { subject: words })
  return created.publicId
}
