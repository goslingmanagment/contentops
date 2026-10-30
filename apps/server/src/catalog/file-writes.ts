import { RAW_PURPOSE_LABEL, type RawPurpose } from '@contentops/contracts/domain/catalog'
import { LIFE_ASSIGNMENT_LABEL, type LifeAssignment } from '@contentops/contracts/domain/files'
import type { Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { handleOf, type MembershipRow, memberships } from './detail'
import { dbRawPurpose, rawPurposeOf } from './entries'
import { type DbItemType, type ItemRow, publicIdOfRow } from './ids'
import { logItemAction, touchItem } from './writes'

/**
 * Files inside one object (DESIGN §4.5): order, picked set frames, life purposes, removal
 * and the purpose of raw footage. Selection and order belong to the membership, so a change
 * in a collection never touches the set the file came from (SPEC §4).
 */

/** Live memberships named by their handles; an unknown handle refuses the whole command. */
export async function filesByKeys(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: readonly string[],
): Promise<{ all: MembershipRow[]; picked: MembershipRow[] }> {
  const all = await memberships(tx, model, [item.id])
  const byKey = new Map(all.map((row) => [handleOf(row.role, row.ordinal, row.variant_no), row]))
  const picked = [...new Set(keys)].map((key) => byKey.get(key))
  const unknown = keys.filter((key) => !byKey.has(key))
  if (unknown.length > 0 || picked.some((row) => row === undefined)) {
    throw new ApiProblem('invalid_request', 'Таких файлов в объекте нет', { keys: unknown })
  }
  return { all, picked: picked as MembershipRow[] }
}

function requireType(item: ItemRow, type: DbItemType, message: string) {
  if (item.type !== type) throw new ApiProblem('invalid_request', message)
}

/** New order: the named files first in the given order, the others after them as they were. */
export async function reorderFiles(tx: Tx, model: ModelScope, item: ItemRow, keys: string[]) {
  const { all, picked } = await filesByKeys(tx, model, item, keys)
  const named = new Set(picked.map((row) => row.id))
  const order = [...picked, ...all.filter((row) => !named.has(row.id))]
  for (const [index, row] of order.entries()) {
    if (row.display_position === index + 1) continue
    await tx.execute(sql`
      UPDATE item_memberships SET display_position = ${index + 1}, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  }
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, { after: { Порядок: keys.join(', ') } })
}

/** Set: «1» — отобрать кадр, «3» — убрать из отобранных. */
export async function pickFiles(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: string[],
  selected: boolean,
) {
  requireType(item, 'SET', 'Кадры отбираются у сета')
  const { picked } = await filesByKeys(tx, model, item, keys)
  const changing = picked.filter((row) => row.selected !== selected)
  for (const row of changing) {
    await tx.execute(sql`
      UPDATE item_memberships SET selected = ${selected}, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  }
  if (changing.length === 0) return
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    after: { [selected ? 'Отобраны' : 'Сняты из отобранных']: keys.join(', ') },
  })
}

/** Life: «В ленту», «В чаты», «Оба»; `null` — без назначения. */
export async function assignFiles(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  keys: string[],
  assignment: LifeAssignment | null,
) {
  requireType(item, 'LIFE', 'Назначение кадров — у лайфа')
  const { picked } = await filesByKeys(tx, model, item, keys)
  for (const row of picked.filter((candidate) => candidate.life_use !== assignment)) {
    await tx.execute(sql`
      UPDATE item_memberships SET life_use = ${assignment}, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  }
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    after: {
      [assignment ? LIFE_ASSIGNMENT_LABEL[assignment] : 'без назначения']: keys.join(', '),
    },
  })
}

/**
 * «Убрать из объекта…»: the membership is closed, its handle stays taken (naming §3) and the
 * bytes stay; the master is not removed — the object would lose what it is.
 */
export async function removeFiles(tx: Tx, model: ModelScope, item: ItemRow, keys: string[]) {
  const { all, picked } = await filesByKeys(tx, model, item, keys)
  if (picked.some((row) => row.kind === 'owned' && row.role === 'master' && row.variant_no === 0)) {
    throw new ApiProblem('invalid_request', 'Мастер из объекта не убирается')
  }
  if (picked.length === all.length) {
    throw new ApiProblem(
      'invalid_request',
      'Все файлы сразу не убираются — объект останется пустым',
    )
  }
  for (const row of picked) {
    await tx.execute(sql`
      UPDATE item_memberships
         SET removed_at = now(), display_position = NULL, row_version = row_version + 1
       WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  }
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    subject: publicIdOfRow(item),
    before: { Файлы: keys.join(', ') },
    after: { Файлы: '—' },
  })
}

/** Raw footage: «Назначение: фупы / PPV / рассылка / неизвестно». */
export async function setRawPurpose(tx: Tx, model: ModelScope, item: ItemRow, purpose: RawPurpose) {
  requireType(item, 'RAW', 'Назначение — у сырья')
  const before = rawPurposeOf(item.raw_purpose)
  await tx.execute(sql`
    UPDATE content_items SET raw_purpose = ${dbRawPurpose(purpose)}
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, {
    before: { Назначение: before ? RAW_PURPOSE_LABEL[before] : '—' },
    after: { Назначение: RAW_PURPOSE_LABEL[purpose] },
  })
}
