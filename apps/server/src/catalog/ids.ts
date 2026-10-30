import {
  formatItemId,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  type ItemId,
  type ItemType,
  parseItemId,
} from '@contentops/contracts/domain/item-type'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'

/**
 * Public IDs and the types of the database (SPEC §4.1): the contract speaks `ppv`, `custom`,
 * the schema `PPV`, `CUS`; the prefix of the ID is the schema's type.
 */

export type DbItemType = 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW' | 'PRM'

export function dbType(type: ItemType): DbItemType {
  return ITEM_TYPE_INFO[type].prefix as DbItemType
}

const TYPE_BY_DB = new Map<string, ItemType>(
  ITEM_TYPES.map((type) => [ITEM_TYPE_INFO[type].prefix, type]),
)

export function itemTypeOfDb(type: string): ItemType {
  const found = TYPE_BY_DB.get(type)
  if (!found) throw new Error(`unknown item type ${type}`)
  return found
}

export function publicIdOf(type: string, number: number): ItemId {
  return formatItemId(itemTypeOfDb(type), number)
}

/** The row of `content_items` the commands work with. */
export interface ItemRow extends Record<string, unknown> {
  id: string
  type: DbItemType
  number: number
  title: string | null
  title_en: string | null
  description: string | null
  ppv_kind: 'bundle' | 'dm' | null
  raw_purpose: 'fyp' | 'ppv' | 'mass_dm' | 'unknown' | null
  has_second_person: boolean | null
  name_in_media: 'yes' | 'no' | 'unknown' | null
  cover_membership_id: string | null
  promo_channel_id: string | null
  merged_into_item_id: string | null
  deleted_at: string | null
  deleted_by: string | null
  row_version: number
}

export function publicIdOfRow(row: Pick<ItemRow, 'type' | 'number'>): ItemId {
  return publicIdOf(row.type, row.number)
}

const ITEM_COLUMNS = sql`
  id, type, number, title, title_en, description, ppv_kind, raw_purpose, has_second_person,
  name_in_media, cover_membership_id, promo_channel_id, merged_into_item_id,
  deleted_at::text AS deleted_at, deleted_by, row_version::int AS row_version`

/** «PPV-073 у Лоры нет»: 404 inside the model the actor may see (SPEC §11.2). */
export function itemNotFound(model: ModelScope, id: string): ApiProblem {
  return new ApiProblem('not_found', `${id}: такого объекта нет`, {
    item_id: id,
    model: model.code,
  })
}

export interface FindItemOptions {
  /** `FOR UPDATE`: the command changes the object. */
  lock?: boolean
  /** A tombstone is found too (the object page shows «Удалён», «Слит с …»). */
  withTombstones?: boolean
}

/** The object of a model by its public ID; another model's object is never found. */
export async function findItem(
  q: Queryable,
  model: ModelScope,
  id: string,
  options: FindItemOptions = {},
): Promise<ItemRow> {
  const parsed = parseItemId(id)
  if (!parsed) throw itemNotFound(model, id)
  const { rows } = await q.execute<ItemRow>(sql`
    SELECT ${ITEM_COLUMNS} FROM content_items
     WHERE model_id = ${model.id}::uuid AND type = ${dbType(parsed.type)}
       AND number = ${parsed.number}
     ${options.lock ? sql`FOR UPDATE` : sql``}`)
  const row = rows[0]
  if (!row || (row.deleted_at !== null && !options.withTombstones)) throw itemNotFound(model, id)
  return row
}

/** Objects by their internal ids, for answers that name other objects. */
export async function itemsByIds(
  q: Queryable,
  model: ModelScope,
  ids: readonly string[],
): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map()
  const { rows } = await q.execute<ItemRow>(sql`
    SELECT ${ITEM_COLUMNS} FROM content_items
     WHERE model_id = ${model.id}::uuid AND id = ANY(${sql.param([...new Set(ids)])}::uuid[])`)
  return new Map(rows.map((row) => [row.id, row]))
}

/** The model of a `/{model}/…` route; `authorize` always sets it there. */
export function modelOf(model: ModelScope | null): ModelScope {
  if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
  return model
}
