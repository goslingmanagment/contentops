import type { ConflictDetails } from '@contentops/contracts/domain/errors'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import { logAction, setJournalItem, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { lastChange } from '../commands'
import type { ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { Snapshot } from '../journal/describe'
import { orderedFields } from '../journal/describe'
import { findItem, type ItemRow, publicIdOfRow } from './ids'

/**
 * What every catalog command shares: the object under its row lock, the version check of
 * the object, «the object changed» (`row_version`) and its one `action` row (schema §9.3).
 */

/** The object locked for the command; the journal's trigger rows carry its id from here. */
export async function lockItem(tx: Tx, model: ModelScope, id: string): Promise<ItemRow> {
  const item = await findItem(tx, model, id, { lock: true })
  await setJournalItem(tx, item.id)
  return item
}

/** Several objects locked in one order (by internal id): two commands never deadlock. */
export async function lockItems(
  tx: Tx,
  model: ModelScope,
  ids: readonly string[],
): Promise<Map<string, ItemRow>> {
  const found = new Map<string, ItemRow>()
  for (const id of ids) found.set(id, await findItem(tx, model, id))
  const ordered = [...found.entries()].sort(([, left], [, right]) =>
    left.id.localeCompare(right.id),
  )
  for (const [id] of ordered) found.set(id, await findItem(tx, model, id, { lock: true }))
  return found
}

/** `If-Match` of the object (SPEC §11.2): 428 without it, 412 with who changed it last. */
export async function checkItemVersion(
  tx: Tx,
  ctx: RequestContext,
  item: ItemRow,
  field: string | null = null,
): Promise<void> {
  if (ctx.ifMatch === null) {
    throw new ApiProblem('precondition_required', 'Нужна версия записи (If-Match)')
  }
  if (ctx.ifMatch === item.row_version) return
  throw await versionConflict(tx, item, field, item.row_version, { version: item.row_version })
}

export async function versionConflict(
  tx: Tx,
  item: ItemRow,
  field: string | null,
  version: number,
  value: unknown,
): Promise<ApiProblem> {
  const details: ConflictDetails = {
    ...(await lastChange(tx, 'content_items', item.id)),
    field,
    current_version: version,
    current_value: value,
  }
  return new ApiProblem('version_mismatch', 'Запись уже изменили', details)
}

/** The object changed: a new version for `If-Match` and the index. */
export async function touchItem(tx: Tx, model: ModelScope, item: ItemRow): Promise<void> {
  await tx.execute(sql`
    UPDATE content_items SET row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
}

/** One `action` row per object: a line of the feed and of the object's «История». */
export async function logItemAction(
  tx: Tx,
  model: ModelScope,
  item: Pick<ItemRow, 'id' | 'type' | 'number'>,
  event: { subject?: string; before?: Snapshot; after?: Snapshot; action?: string } = {},
): Promise<void> {
  const id: ItemId = publicIdOfRow(item)
  await logAction(tx, {
    modelId: model.id,
    action: event.action,
    subjectKind: 'content_items',
    subjectId: item.id,
    subjectLabel: event.subject ?? id,
    itemId: item.id,
    before: event.before ? orderedFields(event.before) : undefined,
    after: event.after ? orderedFields(event.after) : undefined,
  })
}
