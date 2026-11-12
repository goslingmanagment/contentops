import type {
  LinkHubDeliveryCommand,
  RetractHubDeliveryCommand,
} from '@contentops/contracts/domain/hub-orders'
import type { OrderPartKind } from '@contentops/contracts/domain/orders'
import { parseTelegramRef, telegramRefText } from '@contentops/contracts/order-link'
import { logAction, setJournalItem, type Tx } from '@contentops/db'
import type { HubCustomOrder, HubOrderReportBody } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { findItem, publicIdOf, publicIdOfRow } from '../catalog/ids'
import { instant } from '../commands'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { itemFiles, type PartFile, sourceTimeOf } from '../orders/writes'
import { deliveryExcerpt, readHubOrders } from './view'
import { enqueueHubOrders } from './work'

/**
 * Files of a hub order (ecosystem plan 12.11.2026, package N): a CUS linked as a delivery of a
 * part, sealed as `custom_order_deliveries` seals one, and the report the hub must get — in the
 * same transaction, so a delivery never exists here without its way to the hub. The hub derives
 * «сдано частично» and «снято» from the parts; ContentOps never closes an order, never gives one.
 */

const PART_WORD: Record<OrderPartKind, string> = { video: 'видео', photos: 'фото' }
/** The author of ContentOps' lines in the hub's messages of the order. */
const AUTHOR = 'ContentOps'
const NO_TELEGRAM =
  'У заказа в Hub нет сообщения Telegram, а Hub принимает сдачу только под ним: отметьте сдачу в Hub'
/** Orders past these states take no file: given to the fan, closed or cancelled in the hub. */
const ENDED: readonly string[] = ['given', 'closed', 'cancelled']

/** One order at a time: two links of one order never interleave (an advisory lock per code). */
async function lockCode(tx: Tx, model: ModelScope, code: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hub-order:${model.id}:${code}`}))`)
}

async function orderOf(tx: Tx, model: ModelScope, code: string): Promise<HubCustomOrder> {
  const read = await readHubOrders(tx, model.id)
  const order = read.orders.find((candidate) => candidate.code === code)
  if (!order) {
    throw new ApiProblem('not_found', `Заказа ${code} в последнем чтении Hub у этой модели нет`)
  }
  return order
}

function wantsOf(order: HubCustomOrder): { video: boolean; photos: number } {
  const video = order.card.wantsVideo !== false
  const photos = order.card.wantsPhotos ?? 0
  return !video && photos === 0 ? { video: false, photos: 1 } : { video, photos }
}

function messageRefOf(text: string | null | undefined): string | null {
  if (!text) return null
  const ref = parseTelegramRef(text)
  return ref ? telegramRefText(ref) : null
}

/** A live delivery of the same CUS and part with the same versions: a repeat links nothing. */
async function sameLive(
  tx: Tx,
  model: ModelScope,
  code: string,
  itemId: string,
  part: OrderPartKind,
  versionIds: readonly string[],
): Promise<boolean> {
  const { rows } = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM hub_order_deliveries d
       WHERE d.model_id = ${model.id}::uuid AND d.order_code = ${code}
         AND d.item_id = ${itemId}::uuid AND d.part = ${part} AND d.retracts_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM hub_order_deliveries r WHERE r.retracts_id = d.id)
         AND (SELECT array_agg(e.asset_version_id ORDER BY e.asset_version_id)
                FROM asset_manifest_entries e
               WHERE e.model_id = d.model_id AND e.manifest_id = d.manifest_id)
             = (SELECT array_agg(v ORDER BY v) FROM unnest(${sql.param([...versionIds])}::uuid[]) v)
    ) AS found`)
  return rows[0]?.found === true
}

/** Distinct photos in the live deliveries of the order, with the ones about to be linked. */
async function livePhotos(
  tx: Tx,
  model: ModelScope,
  code: string,
  adding: readonly PartFile[],
): Promise<number> {
  const { rows } = await tx.execute<{ asset_id: string }>(sql`
    SELECT DISTINCT e.asset_id
      FROM hub_order_deliveries d
      JOIN asset_manifest_entries e ON e.model_id = d.model_id AND e.manifest_id = d.manifest_id
     WHERE d.model_id = ${model.id}::uuid AND d.order_code = ${code} AND d.part = 'photos'
       AND d.retracts_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM hub_order_deliveries r WHERE r.retracts_id = d.id)`)
  return new Set([...rows.map((row) => row.asset_id), ...adding.map((file) => file.asset_id)]).size
}

async function addReport(
  tx: Tx,
  model: ModelScope,
  input: {
    code: string
    deliveryId: string
    kind: 'delivery' | 'retraction'
    body: HubOrderReportBody | null
    ref: string | null
  },
): Promise<void> {
  // Without a Telegram message the hub has nowhere to keep the step: refused at once, in words.
  const refused = input.ref === null || input.body === null
  await tx.execute(sql`
    INSERT INTO hub_order_reports (model_id, order_code, delivery_id, kind, body, state, error)
    VALUES (${model.id}::uuid, ${input.code}, ${input.deliveryId}::uuid, ${input.kind},
            ${JSON.stringify(input.body ?? {})}::jsonb, ${refused ? 'refused' : 'pending'},
            ${refused ? NO_TELEGRAM : null})`)
}

/**
 * «Привязать файл…» of a hub order: per part, a sealed composition of the current versions of
 * the CUS's files and a report `delivery` with the part and whether it is whole now. The hub
 * keeps the delivery under a Telegram message: the one that brought the files, else the order's
 * card (the hub refuses a step without one).
 */
export async function linkHubDelivery(
  tx: Tx,
  model: ModelScope,
  code: string,
  body: LinkHubDeliveryCommand,
  actor: Actor,
  requestId: string,
): Promise<void> {
  await lockCode(tx, model, code)
  const order = await orderOf(tx, model, code)
  if (ENDED.includes(order.state)) {
    throw new ApiProblem('order_closed', `Не выполнено: заказ ${code} в Hub уже отдан или закрыт`)
  }
  const item = await findItem(tx, model, body.item_id)
  if (item.type !== 'CUS') {
    throw new ApiProblem('invalid_request', 'Сдача по заказу — это кастом (CUS)', {
      field: 'item_id',
    })
  }
  await setJournalItem(tx, item.id)
  const itemId = publicIdOfRow(item)
  const wants = wantsOf(order)
  const files = await itemFiles(tx, model, item.id)
  const ofPart = (part: OrderPartKind) =>
    files.filter((file) => file.media_kind === (part === 'video' ? 'video' : 'image'))
  const expects = (part: OrderPartKind) => (part === 'video' ? wants.video : wants.photos > 0)
  if (body.part && !expects(body.part)) {
    throw new ApiProblem('invalid_request', `В заказе нет части «${PART_WORD[body.part]}»`, {
      field: 'part',
    })
  }
  const parts: OrderPartKind[] = body.part
    ? [body.part]
    : (['video', 'photos'] as const).filter((part) => expects(part) && ofPart(part).length > 0)
  if (parts.length === 0 || parts.some((part) => ofPart(part).length === 0)) {
    throw new ApiProblem('order_not_complete', `В ${itemId} нет файлов той части, что заказана`, {
      item_id: itemId,
    })
  }
  const messageRef = messageRefOf(body.message_url)
  if (body.message_url && !messageRef) {
    throw new ApiProblem('invalid_request', 'Нужна ссылка на сообщение в Telegram', {
      field: 'message_url',
    })
  }
  const ref = messageRef ?? order.telegramRefs[0] ?? null
  const linked: string[] = []
  for (const part of parts) {
    const chosen = ofPart(part)
    const versionIds = chosen.map((file) => file.version_id)
    if (await sameLive(tx, model, code, item.id, part, versionIds)) continue
    const deliveredAt = instant(
      body.delivered_at ?? (await sourceTimeOf(tx, model, item.id, versionIds)),
    )
    const complete =
      body.complete ??
      (part === 'video' ? true : (await livePhotos(tx, model, code, chosen)) >= wants.photos)
    const { rows } = await tx.execute<{ id: string }>(sql`
      INSERT INTO asset_manifests (model_id, purpose, origin_item_id, entry_count, created_by)
      VALUES (${model.id}::uuid, 'submission', ${item.id}::uuid, ${chosen.length}, ${actor.id}::uuid)
      RETURNING id`)
    const manifestId = rows[0]?.id
    if (!manifestId) throw new Error('manifest insert returned nothing')
    for (const [index, file] of chosen.entries()) {
      await tx.execute(sql`
        INSERT INTO asset_manifest_entries (model_id, manifest_id, position, item_id,
                                            membership_id, asset_id, asset_version_id,
                                            handle_snapshot)
        VALUES (${model.id}::uuid, ${manifestId}::uuid, ${index + 1}, ${item.id}::uuid,
                ${file.membership_id}::uuid, ${file.asset_id}::uuid, ${file.version_id}::uuid,
                ${file.handle || 'file'})`)
    }
    const { rows: inserted } = await tx.execute<{ id: string }>(sql`
      INSERT INTO hub_order_deliveries (model_id, order_code, part, complete, item_id, manifest_id,
                                        message_ref, delivered_at, linked_by)
      VALUES (${model.id}::uuid, ${code}, ${part}, ${complete}, ${item.id}::uuid,
              ${manifestId}::uuid, ${messageRef}, ${deliveredAt}::timestamptz, ${actor.id}::uuid)
      RETURNING id`)
    const deliveryId = inserted[0]?.id
    if (!deliveryId) throw new Error('delivery insert returned nothing')
    await addReport(tx, model, {
      code,
      deliveryId,
      kind: 'delivery',
      ref,
      body: ref
        ? {
            action: 'delivery',
            message: {
              telegramRef: ref,
              at: deliveredAt,
              author: AUTHOR,
              excerpt: deliveryExcerpt(itemId, part, chosen.length),
            },
            part,
            complete,
          }
        : null,
    })
    linked.push(`${PART_WORD[part]}${complete ? '' : ' (не вся часть)'}`)
    await logAction(tx, {
      modelId: model.id,
      subjectKind: 'hub_order_deliveries',
      subjectId: deliveryId,
      subjectLabel: `${code} · ${itemId}`,
      itemId: item.id,
      after: {
        Заказ: code,
        Сдача: `${itemId} · ${PART_WORD[part]}`,
        Целиком: complete ? 'да' : 'нет',
      },
    })
  }
  if (linked.length > 0) await enqueueHubOrders(tx, model.id, `link:${requestId}`)
}

/** «Отвязать…»: a new record retracts the delivery; the hub gets a note of the order. */
export async function retractHubDelivery(
  tx: Tx,
  model: ModelScope,
  code: string,
  deliveryId: string,
  body: RetractHubDeliveryCommand,
  requestId: string,
): Promise<void> {
  await lockCode(tx, model, code)
  const order = await orderOf(tx, model, code)
  const isUuid = /^[0-9a-f-]{36}$/i.test(deliveryId)
  const { rows } = isUuid
    ? await tx.execute<{
        id: string
        part: OrderPartKind
        item_id: string
        type: string
        number: number
        message_ref: string | null
        retracted: boolean
      }>(sql`
        SELECT d.id, d.part, d.item_id, c.type, c.number, d.message_ref,
               EXISTS (SELECT 1 FROM hub_order_deliveries r WHERE r.retracts_id = d.id) AS retracted
          FROM hub_order_deliveries d
          JOIN content_items c ON c.model_id = d.model_id AND c.id = d.item_id
         WHERE d.model_id = ${model.id}::uuid AND d.order_code = ${code}
           AND d.id = ${deliveryId}::uuid AND d.retracts_id IS NULL`)
    : { rows: [] }
  const delivery = rows[0]
  if (!delivery) throw new ApiProblem('not_found', 'Такой сдачи у заказа нет')
  if (delivery.retracted) return
  await setJournalItem(tx, delivery.item_id)
  const { rows: inserted } = await tx.execute<{ id: string }>(sql`
    INSERT INTO hub_order_deliveries (model_id, order_code, retracts_id, retract_reason)
    VALUES (${model.id}::uuid, ${code}, ${delivery.id}::uuid, ${body.reason})
    RETURNING id`)
  const retractionId = inserted[0]?.id
  if (!retractionId) throw new Error('retraction insert returned nothing')
  const itemId = publicIdOf(delivery.type, delivery.number)
  // The hub keeps one message per link: a note under a link it has already would be lost, so
  // the note goes under a link of the order the hub has no message of, when there is one.
  const used = new Set(order.messages.map((message) => message.telegramRef))
  const candidates = [
    ...order.telegramRefs,
    ...(delivery.message_ref ? [delivery.message_ref] : []),
  ]
  const ref = candidates.find((candidate) => !used.has(candidate)) ?? candidates[0] ?? null
  const excerpt = `ContentOps: сдача ${itemId} · ${PART_WORD[delivery.part]} отвязана — ${body.reason}`
  await addReport(tx, model, {
    code,
    deliveryId: retractionId,
    kind: 'retraction',
    ref,
    body: ref
      ? {
          action: 'message',
          kind: 'note',
          message: {
            telegramRef: ref,
            at: new Date().toISOString(),
            author: AUTHOR,
            excerpt: excerpt.slice(0, 500),
          },
        }
      : null,
  })
  await logAction(tx, {
    modelId: model.id,
    subjectKind: 'hub_order_deliveries',
    subjectId: delivery.id,
    subjectLabel: `${code} · ${itemId}`,
    itemId: delivery.item_id,
    after: {
      Заказ: code,
      Отвязано: `${itemId} · ${PART_WORD[delivery.part]}`,
      Причина: body.reason,
    },
  })
  await enqueueHubOrders(tx, model.id, `retract:${requestId}`)
}
