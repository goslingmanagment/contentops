import type { NewProvenanceLink } from '@contentops/contracts/domain/provenance'
import { PROVENANCE_LABEL } from '@contentops/contracts/domain/provenance'
import { dbErrorCode, setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { isUuid } from '../commands'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { RELATION_IN_SCHEMA, SUGGESTED_BASIS } from './detail'
import { type ItemRow, itemsByIds, publicIdOfRow } from './ids'
import { lockItems, logItemAction, touchItem } from './writes'

/**
 * Provenance between objects (SPEC §2.1 п. 5, schema §3.2): «Сделано из», «PPV из кастома».
 * A cycle is checked in code under the locks of both objects, so two commands that would
 * close a circle together run one after the other and the second is refused.
 */

const MANUAL_BASIS = 'manual'

/** Whether `ancestor` already comes from `descendant` through object links. */
async function comesFrom(tx: Tx, model: ModelScope, descendant: string, ancestor: string) {
  const { rows } = await tx.execute<{ found: boolean }>(sql`
    WITH RECURSIVE up (item_id) AS (
      SELECT ${descendant}::uuid
      UNION
      SELECT p.parent_item_id FROM provenance p JOIN up ON p.child_item_id = up.item_id
       WHERE p.model_id = ${model.id}::uuid AND p.voided_by_id IS NULL
         AND p.parent_item_id IS NOT NULL
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE item_id = ${ancestor}::uuid) AS found`)
  return rows[0]?.found === true
}

/** Both ends of a change get the line in their «История». */
async function logBoth(
  tx: Tx,
  model: ModelScope,
  ends: readonly ItemRow[],
  words: string,
): Promise<void> {
  for (const end of ends) {
    await setJournalItem(tx, end.id)
    await touchItem(tx, model, end)
    await logItemAction(tx, model, end, { subject: words })
  }
}

export async function addLink(
  tx: Tx,
  model: ModelScope,
  id: string,
  link: NewProvenanceLink,
  actor: Actor,
): Promise<void> {
  const items = await lockItems(tx, model, [id, link.item_id])
  const self = items.get(id)
  const other = items.get(link.item_id)
  if (!self || !other) throw new Error('locked items vanished')
  if (self.id === other.id) {
    throw new ApiProblem('invalid_request', 'Объект не связывается сам с собой')
  }
  const [child, parent] = link.direction === 'out' ? [self, other] : [other, self]
  if (await comesFrom(tx, model, parent.id, child.id)) {
    throw new ApiProblem(
      'invalid_request',
      `${publicIdOfRow(parent)} уже сделан из ${publicIdOfRow(child)} — связь замкнёт круг`,
    )
  }
  await setJournalItem(tx, self.id)
  try {
    await tx.execute(sql`SAVEPOINT add_link`)
    await tx.execute(sql`
      INSERT INTO provenance (model_id, relation, child_item_id, parent_item_id, basis, created_by)
      VALUES (${model.id}::uuid, ${RELATION_IN_SCHEMA[link.relation]}, ${child.id}::uuid,
              ${parent.id}::uuid, ${MANUAL_BASIS}, ${actor.id}::uuid)`)
  } catch (error) {
    if (dbErrorCode(error) !== '23505') throw error
    await tx.execute(sql`ROLLBACK TO SAVEPOINT add_link`)
    throw new ApiProblem('invalid_request', 'Такая связь уже есть')
  }
  const words = `${publicIdOfRow(child)} ← ${publicIdOfRow(parent)} (${PROVENANCE_LABEL[link.relation].out.toLowerCase()})`
  await logBoth(tx, model, [self, other], words)
}

interface LinkRow extends Record<string, unknown> {
  id: string
  child_item_id: string
  parent_item_id: string
  basis: string | null
}

async function linkOf(tx: Tx, model: ModelScope, item: ItemRow, link: string): Promise<LinkRow> {
  const { rows } = isUuid(link)
    ? await tx.execute<LinkRow>(sql`
        SELECT id, child_item_id, parent_item_id, basis FROM provenance
         WHERE model_id = ${model.id}::uuid AND id = ${link}::uuid AND voided_by_id IS NULL
           AND (child_item_id = ${item.id}::uuid OR parent_item_id = ${item.id}::uuid)
         FOR UPDATE`)
    : { rows: [] }
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такой связи у объекта нет')
  return row
}

async function endsOf(tx: Tx, model: ModelScope, row: LinkRow): Promise<ItemRow[]> {
  const ends = await itemsByIds(tx, model, [row.child_item_id, row.parent_item_id])
  return [...ends.values()]
}

function linkWords(ends: readonly ItemRow[], row: LinkRow): string {
  const child = ends.find((end) => end.id === row.child_item_id)
  const parent = ends.find((end) => end.id === row.parent_item_id)
  return child && parent ? `${publicIdOfRow(child)} ← ${publicIdOfRow(parent)}` : ''
}

export async function confirmLink(tx: Tx, model: ModelScope, item: ItemRow, link: string) {
  const row = await linkOf(tx, model, item, link)
  if (row.basis !== SUGGESTED_BASIS) return
  await tx.execute(sql`
    UPDATE provenance SET basis = ${MANUAL_BASIS}
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  const ends = await endsOf(tx, model, row)
  await logBoth(tx, model, ends, linkWords(ends, row))
}

export async function removeLink(tx: Tx, model: ModelScope, item: ItemRow, link: string) {
  const row = await linkOf(tx, model, item, link)
  const ends = await endsOf(tx, model, row)
  await tx.execute(sql`
    DELETE FROM provenance WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  await logBoth(tx, model, ends, linkWords(ends, row))
}
