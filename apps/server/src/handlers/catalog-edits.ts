import { FAN_NAME_LABEL } from '@contentops/contracts/domain/catalog'
import type { BatchResult } from '@contentops/contracts/domain/pagination'
import { plural } from '@contentops/contracts/format'
import type { Tx } from '@contentops/db'
import { setJournalItem } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { itemDetail } from '../catalog/detail'
import {
  assignFiles,
  pickFiles,
  removeFiles,
  reorderFiles,
  setRawPurpose,
} from '../catalog/file-writes'
import { findItem, type ItemRow, modelOf, publicIdOfRow } from '../catalog/ids'
import { addLink, confirmLink, removeLink } from '../catalog/links'
import { makePpvFromCustom } from '../catalog/make-ppv'
import { changeTags, confirmMarkup, updateField } from '../catalog/markup-writes'
import { changeType, extractShoot, mergeRaw, removeItem, restoreItem } from '../catalog/structure'
import { checkItemVersion, lockItem, logItemAction, touchItem } from '../catalog/writes'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'

/**
 * Changing objects of the catalog (DESIGN §4.4–4.5, SPEC §5, §11.2): markup fields by their
 * own versions, flags and files by the object's version, provenance, and the Library's batch
 * commands «по каждой записи». Every command answers with what the server saved.
 */

const yesNo = (value: boolean | null) => (value === null ? 'не проверено' : value ? 'да' : 'нет')

/** Open (unmarked, not cancelled) rows of the objects on OnlyFans pages. */
async function openOnlyFansRows(tx: Tx, model: ModelScope, itemIds: readonly string[]) {
  if (itemIds.length === 0) return 0
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM posting_plan_rows r
      JOIN accounts a ON a.model_id = r.model_id AND a.id = r.account_id
     WHERE r.model_id = ${model.id}::uuid AND r.item_id = ANY(${sql.param([...itemIds])}::uuid[])
       AND a.platform = 'onlyfans' AND r.marked_at IS NULL AND r.cancelled_at IS NULL`)
  return rows[0]?.n ?? 0
}

/**
 * A flag set after the plan cancels the open OnlyFans rows of the object (SPEC §7; the
 * database does it, trigger `content_items_second_person_late`): the person agrees first —
 * «Снимет 2 строки на OnlyFans · Снять и отметить».
 */
async function requireConsent(
  tx: Tx,
  model: ModelScope,
  items: readonly ItemRow[],
  consent: boolean | undefined,
) {
  const flagged = items.filter((item) => item.has_second_person !== true)
  const rows = await openOnlyFansRows(
    tx,
    model,
    flagged.map((item) => item.id),
  )
  if (rows > 0 && !consent) {
    throw new ApiProblem(
      'second_person_onlyfans',
      `Снимет ${rows} ${plural(rows, ['строку', 'строки', 'строк'])} на OnlyFans`,
      { rows },
    )
  }
}

/** «Второй человек в кадре» and «Имя фана в ролике». */
async function setFlags(
  tx: Tx,
  model: ModelScope,
  item: ItemRow,
  flags: {
    second_person?: boolean
    fan_name?: 'yes' | 'no' | 'unknown'
    cancel_onlyfans_rows?: boolean
  },
) {
  if (flags.second_person === true) {
    await requireConsent(tx, model, [item], flags.cancel_onlyfans_rows)
  }
  if (flags.fan_name !== undefined && item.type !== 'CUS') {
    throw new ApiProblem('invalid_request', 'Имя фана в ролике — у кастома', { field: 'fan_name' })
  }
  const before: Record<string, string> = {}
  const after: Record<string, string> = {}
  if (flags.second_person !== undefined) {
    before['Второй человек в кадре'] = yesNo(item.has_second_person)
    after['Второй человек в кадре'] = yesNo(flags.second_person)
  }
  if (flags.fan_name !== undefined) {
    before['Имя фана в ролике'] = item.name_in_media ? FAN_NAME_LABEL[item.name_in_media] : '—'
    after['Имя фана в ролике'] = FAN_NAME_LABEL[flags.fan_name]
  }
  await tx.execute(sql`
    UPDATE content_items
       SET has_second_person = ${flags.second_person ?? item.has_second_person},
           name_in_media = ${flags.fan_name ?? item.name_in_media}
     WHERE model_id = ${model.id}::uuid AND id = ${item.id}::uuid`)
  await touchItem(tx, model, item)
  await logItemAction(tx, model, item, { before, after })
}

/** A batch: one transaction, one result per object; a missing object fails only itself. */
async function eachItem(
  tx: Tx,
  model: ModelScope,
  ids: readonly string[],
  run: (item: ItemRow) => Promise<void>,
): Promise<BatchResult> {
  const results: BatchResult['results'] = []
  for (const id of [...new Set(ids)]) {
    const item = await findItem(tx, model, id, { lock: true }).catch(() => null)
    if (!item) {
      results.push({ id, ok: false, code: 'not_found' })
      continue
    }
    await setJournalItem(tx, item.id)
    await run(item)
    results.push({ id, ok: true, code: null })
  }
  return { results }
}

export function catalogEditHandlers({ command }: Services): HandlerRegistry {
  /** The command on one object under its lock, answered with the object page. */
  const onItem = <T>(
    input: { ctx: Parameters<typeof command>[0]['ctx']; body: unknown; id: string },
    run: (tx: Tx, model: ModelScope, item: ItemRow, actor: Actor) => Promise<T>,
  ) =>
    command(input, async (tx, actor) => {
      const model = modelOf(input.ctx.model)
      const item = await lockItem(tx, model, input.id)
      await run(tx, model, item, actor)
      return itemDetail(tx, model, input.id)
    })

  return {
    objects: {
      updateField: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, (tx, model, item, actor) =>
          updateField(tx, ctx, model, item, params.field, body, actor),
        ),
      confirmMarkup: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, (tx, model, item, actor) =>
          confirmMarkup(tx, model, item, body, actor),
        ),
      setFlags: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, async (tx, model, item) => {
          await checkItemVersion(tx, ctx, item)
          await setFlags(tx, model, item, body)
        }),
      addLink: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          await addLink(tx, model, params.id, body, actor)
          return itemDetail(tx, model, params.id)
        }),
      confirmLink: ({ params, ctx }) =>
        onItem({ ctx, body: null, id: params.id }, (tx, model, item) =>
          confirmLink(tx, model, item, params.link),
        ),
      removeLink: ({ params, ctx }) =>
        onItem({ ctx, body: null, id: params.id }, (tx, model, item) =>
          removeLink(tx, model, item, params.link),
        ),
      // «Сделать PPV» из кастома, «Взять мастер как есть» (DESIGN §6.6).
      makePpv: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const item = await lockItem(tx, model, params.id)
          return makePpvFromCustom(tx, model, item, body, actor)
        }),
      changeType: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const item = await lockItem(tx, model, params.id)
          await checkItemVersion(tx, ctx, item)
          return { item_id: await changeType(tx, model, item, body.type, actor) }
        }),
      remove: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const item = await lockItem(tx, model, params.id)
          await checkItemVersion(tx, ctx, item)
          await removeItem(tx, model, item, actor)
          return { ok: true as const }
        }),
      restore: ({ params, ctx }) =>
        command({ ctx, body: null }, async (tx) => {
          const model = modelOf(ctx.model)
          const item = await findItem(tx, model, params.id, { lock: true, withTombstones: true })
          await setJournalItem(tx, item.id)
          await restoreItem(tx, model, item)
          return itemDetail(tx, model, params.id)
        }),
    },
    objectFiles: {
      reorder: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, async (tx, model, item) => {
          await checkItemVersion(tx, ctx, item)
          await reorderFiles(tx, model, item, body.keys)
        }),
      pick: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, (tx, model, item) =>
          pickFiles(tx, model, item, body.keys, body.selected),
        ),
      assign: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, (tx, model, item) =>
          assignFiles(tx, model, item, body.keys, body.assignment),
        ),
      remove: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, async (tx, model, item) => {
          await checkItemVersion(tx, ctx, item)
          await removeFiles(tx, model, item, body.keys)
        }),
      merge: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => ({
          item_id: await mergeRaw(tx, modelOf(ctx.model), params.id, body.into, ctx, actor),
        })),
      extractShoot: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx.model)
          const item = await lockItem(tx, model, params.id)
          return { item_id: await extractShoot(tx, model, item, body.keys, actor) }
        }),
      setPurpose: ({ params, body, ctx }) =>
        onItem({ ctx, body, id: params.id }, async (tx, model, item) => {
          await checkItemVersion(tx, ctx, item)
          await setRawPurpose(tx, model, item, body.purpose)
        }),
    },
    objectBatch: {
      tags: ({ body, ctx }) =>
        command({ ctx, body }, (tx, actor) => {
          const model = modelOf(ctx.model)
          return eachItem(tx, model, body.items, async (item) => {
            await changeTags(tx, model, item, { add: body.add, remove: body.remove }, actor)
            await touchItem(tx, model, item)
            await logItemAction(tx, model, item, {
              subject: publicIdOfRow(item),
              after: {
                ...(body.add.length > 0 ? { Добавлены: body.add.join(', ') } : {}),
                ...(body.remove.length > 0 ? { Сняты: body.remove.join(', ') } : {}),
              },
            })
          })
        }),
      secondPerson: ({ body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const model = modelOf(ctx.model)
          if (body.second_person) {
            const items = []
            for (const id of new Set(body.items)) {
              const item = await findItem(tx, model, id).catch(() => null)
              if (item) items.push(item)
            }
            await requireConsent(tx, model, items, body.cancel_onlyfans_rows)
          }
          return eachItem(tx, model, body.items, (item) =>
            setFlags(tx, model, item, {
              second_person: body.second_person,
              cancel_onlyfans_rows: true,
            }),
          )
        }),
    },
  }
}
