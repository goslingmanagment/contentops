import { randomUUID } from 'node:crypto'
import type {
  AddOrderMessageCommand,
  AddRevisionCommand,
  CompleteRevisionCommand,
  LinkDeliveryCommand,
  OrderFields,
  UpdateOrderCommand,
} from '@contentops/contracts/commands/orders'
import { FAN_NAME_LABEL } from '@contentops/contracts/domain/catalog'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { OrderPartKind } from '@contentops/contracts/domain/orders'
import { parseDuration } from '@contentops/contracts/order-card'
import { orderAddress, parseTelegramRef, telegramRefText } from '@contentops/contracts/order-link'
import { dbErrorCode, logAction, setJournalItem, type Tx } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { findItem, publicIdOfRow } from '../catalog/ids'
import { checkVersion, instant } from '../commands'
import type { Actor, ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import { orderedFields, type Snapshot } from '../journal/describe'
import {
  deadlineOf,
  dueAtOf,
  ORDER_COLUMNS,
  ORDER_FROM,
  type OrderRow,
  orderCondition,
  orderLabel,
  orderNotFound,
} from './view'

/**
 * Commands of an order (SPEC §5, §8.2; schema §3.7, §9.2). Every command locks the order row
 * first — deliveries, retractions, revisions, marks and closing of one order never interleave —
 * then checks the rule, writes, and leaves one `action` row with the order as its subject.
 * The database keeps the same rules in its triggers: a race the checks here miss is refused there.
 */

const PART_WORD: Record<OrderPartKind, string> = { video: 'видео', photos: 'фото' }

/** The order under its row lock, by the address of the path. */
export async function lockOrder(tx: Tx, model: ModelScope, address: string): Promise<OrderRow> {
  const condition = orderCondition(address)
  if (!condition) throw orderNotFound(model)
  const { rows } = await tx.execute<OrderRow>(sql`
    SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM}
     WHERE o.model_id = ${model.id}::uuid AND ${condition}
     FOR UPDATE OF o`)
  const row = rows[0]
  if (!row) throw orderNotFound(model)
  return row
}

async function reread(tx: Tx, model: ModelScope, id: string): Promise<OrderRow> {
  return lockOrder(tx, model, id)
}

/** The order changed: a new version for `If-Match` and the lists. */
async function touch(tx: Tx, model: ModelScope, row: OrderRow): Promise<void> {
  await tx.execute(sql`
    UPDATE custom_orders SET row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
}

async function logOrder(
  tx: Tx,
  model: ModelScope,
  row: Pick<OrderRow, 'id' | 'brief'>,
  event: { before?: Snapshot; after?: Snapshot; itemId?: string | null } = {},
): Promise<void> {
  await logAction(tx, {
    modelId: model.id,
    subjectKind: 'custom_orders',
    subjectId: row.id,
    subjectLabel: orderLabel(row),
    itemId: event.itemId ?? null,
    before: event.before ? orderedFields(event.before) : undefined,
    after: event.after ? orderedFields(event.after) : undefined,
  })
}

/** Closed and cancelled orders are final: no deliveries, marks or open revisions (schema §9.2). */
function requireOpen(row: OrderRow): void {
  if (row.status === 'closed')
    throw new ApiProblem('order_closed', 'Не выполнено: заказ уже закрыт')
  if (row.status === 'cancelled') throw new ApiProblem('order_closed', 'Не выполнено: заказ снят')
}

/** A refusal of the order triggers (`CO005`) the checks here did not foresee. */
async function domainRule<T>(run: () => Promise<T>, code: 'order_closed' | 'order_not_complete') {
  try {
    return await run()
  } catch (error) {
    if (dbErrorCode(error) === 'CO005') {
      throw new ApiProblem(code, 'Не выполнено: заказ изменился, обновите его')
    }
    throw error
  }
}

/** A Telegram link in the stored form; another reference is kept as given. */
function messageRef(text: string): string {
  const ref = parseTelegramRef(text)
  return ref ? telegramRefText(ref) : text.trim()
}

async function accountIdOf(tx: Tx, model: ModelScope, code: string | null): Promise<string | null> {
  if (code === null) return null
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM accounts WHERE model_id = ${model.id}::uuid AND code = ${code}`)
  const id = rows[0]?.id
  if (!id) throw new ApiProblem('invalid_request', 'Такой страницы нет', { field: 'account' })
  return id
}

function wantsWords(video: boolean, photos: number): string {
  return [video ? 'видео' : null, photos > 0 ? `${photos} фото` : null].filter(Boolean).join(' и ')
}

// ---------------------------------------------------------------------------
// Create and fields
// ---------------------------------------------------------------------------

/** «Новый заказ» and the routine: one card — one order (SPEC §4.1). */
export async function createOrder(
  tx: Tx,
  model: ModelScope,
  body: OrderFields,
  actor: Actor,
): Promise<string> {
  const ref = parseTelegramRef(body.message_url)
  if (!ref) {
    throw new ApiProblem('invalid_request', 'Нужна ссылка на карточку в Telegram', {
      field: 'message_url',
    })
  }
  const address = orderAddress(ref)
  const { rows: existing } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM custom_orders
     WHERE model_id = ${model.id}::uuid AND tg_chat = ${ref.chat}
       AND tg_topic IS NOT DISTINCT FROM ${ref.topic}::bigint AND tg_message_id = ${ref.message}::bigint`)
  if (existing[0]) {
    throw new ApiProblem('order_exists', 'По этой карточке заказ уже заведён', { order: address })
  }
  const accountId = await accountIdOf(tx, model, body.account)
  const duration = parseDuration(body.duration_raw)
  const photos = body.wants_photos
  const { rows } = await tx.execute<{ id: string; card_at: string }>(sql`
    INSERT INTO custom_orders (
      model_id, account_id, tg_chat, tg_topic, tg_message_id, card_author, card_at, buyer_name,
      brief, ordered_duration_raw, duration_min_s, duration_max_s, expects_video, expects_photos,
      photo_count, due_at, name_in_media, created_by
    ) VALUES (
      ${model.id}::uuid, ${accountId}::uuid, ${ref.chat}, ${ref.topic}::bigint,
      ${ref.message}::bigint, ${body.card_author?.trim() ?? ''},
      coalesce(${body.card_at ?? null}::timestamptz, now()), ${body.buyer || null}, ${body.brief},
      ${body.duration_raw.trim() || null}, ${duration?.min_s ?? null}, ${duration?.max_s ?? null},
      ${body.wants_video}, ${photos > 0}, ${photos > 0 ? photos : null},
      ${dueAtOf(body.deadline)}::timestamptz, ${body.fan_name}, ${actor.id}::uuid
    )
    ON CONFLICT ON CONSTRAINT custom_orders_card DO NOTHING
    RETURNING id, card_at::text AS card_at`)
  const created = rows[0]
  if (!created) {
    throw new ApiProblem('order_exists', 'По этой карточке заказ уже заведён', { order: address })
  }
  if (body.card_text?.trim()) {
    await tx.execute(sql`
      INSERT INTO custom_order_messages (model_id, order_id, tg_ref, kind, message_at, author,
                                         excerpt, recorded_by)
      VALUES (${model.id}::uuid, ${created.id}::uuid, ${telegramRefText(ref)}, 'card',
              ${created.card_at}::timestamptz, ${body.card_author?.trim() ?? ''},
              ${body.card_text.trim()}, ${actor.id}::uuid)`)
  }
  await logOrder(
    tx,
    model,
    { id: created.id, brief: body.brief },
    {
      after: {
        Карточка: telegramRefText(ref),
        ...(body.buyer ? { Покупатель: body.buyer } : {}),
        ...(body.account ? { Страница: body.account } : {}),
        Ждём: wantsWords(body.wants_video, photos),
        ...(body.duration_raw.trim() ? { Длительность: body.duration_raw.trim() } : {}),
        ...(body.deadline ? { Срок: body.deadline } : {}),
        'Имя фана в ролике': FAN_NAME_LABEL[body.fan_name],
      },
    },
  )
  return address
}

/** API field → the columns it writes; the journal knows who wrote each column last. */
const FIELD_COLUMNS: Record<keyof UpdateOrderCommand, readonly string[]> = {
  buyer: ['buyer_name'],
  account: ['account_id'],
  brief: ['brief'],
  duration_raw: ['ordered_duration_raw'],
  wants_video: ['expects_video'],
  wants_photos: ['expects_photos', 'photo_count'],
  deadline: ['due_at'],
  fan_name: ['name_in_media'],
  card_author: ['card_author'],
  card_at: ['card_at'],
}

const FIELD_LABEL: Record<keyof UpdateOrderCommand, string> = {
  buyer: 'Покупатель',
  account: 'Страница',
  brief: 'ТЗ',
  duration_raw: 'Длительность',
  wants_video: 'Видео',
  wants_photos: 'Фото',
  deadline: 'Срок',
  fan_name: 'Имя фана в ролике',
  card_author: 'Автор карточки',
  card_at: 'Время карточки',
}

type Field = keyof UpdateOrderCommand

function currentValue(row: OrderRow, field: Field): string | number | boolean | null {
  switch (field) {
    case 'buyer':
      return row.buyer_name
    case 'account':
      return row.account_code
    case 'brief':
      return row.brief
    case 'duration_raw':
      return row.ordered_duration_raw ?? ''
    case 'wants_video':
      return row.expects_video
    case 'wants_photos':
      return row.expects_photos ? (row.photo_count ?? 1) : 0
    case 'deadline':
      return deadlineOf(row.due_at)
    case 'fan_name':
      return row.name_in_media
    case 'card_author':
      return row.card_author
    case 'card_at':
      return new Date(row.card_at.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toISOString()
  }
}

/** An empty value is not an edit to protect: the agent may fill it (SPEC §8.2). */
function isEmpty(value: unknown): boolean {
  return value === null || value === '' || value === 'unknown'
}

function words(value: unknown): string {
  if (value === null || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  return String(value)
}

interface ColumnWriter {
  column: string
  type: 'human' | 'agent' | 'system'
  label: string
  at: string
}

/** Who wrote each column of the order last: the journal's `change` rows (schema §9.3). */
async function lastWriters(tx: Tx, model: ModelScope, orderId: string): Promise<ColumnWriter[]> {
  const { rows } = await tx.execute<ColumnWriter & Record<string, unknown>>(sql`
    SELECT DISTINCT ON (k.key) k.key AS column, a.actor_type AS type, a.actor_label AS label,
           a.at::text AS at
      FROM action_log a, jsonb_object_keys(a.after) k(key)
     WHERE a.model_id = ${model.id}::uuid AND a.subject_kind = 'custom_orders'
       AND a.subject_id = ${orderId}::uuid AND a.entry_kind = 'change'
       AND jsonb_typeof(a.after) = 'object'
     ORDER BY k.key, a.id DESC`)
  return rows
}

/**
 * Field by field; `If-Match` of the order. An agent does not overwrite a field a person wrote
 * last (SPEC §8.2): the change is refused with the fields, the routine reports them instead.
 */
export async function updateOrder(
  tx: Tx,
  ctx: RequestContext,
  model: ModelScope,
  address: string,
  body: UpdateOrderCommand,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  await checkVersion(
    tx,
    ctx,
    { version: row.row_version, subjectKind: 'custom_orders', subjectId: row.id, field: 'order' },
    () => ({ version: row.row_version }),
  )
  const changed = (Object.keys(body) as Field[]).filter((field) => {
    const next = body[field]
    if (next === undefined) return false
    return next !== currentValue(row, field) && !(field === 'card_at' && next === null)
  })
  if (changed.length === 0) return

  if (actor.type === 'agent') {
    const writers = await lastWriters(tx, model, row.id)
    const owned = changed.filter((field) => {
      if (isEmpty(currentValue(row, field))) return false
      return FIELD_COLUMNS[field].some(
        (column) => writers.find((writer) => writer.column === column)?.type === 'human',
      )
    })
    if (owned.length > 0) {
      throw new ApiProblem(
        'edited_by_person',
        'Эти поля последним правил человек — агент их не перезаписывает',
        {
          fields: owned,
          edited: owned.map((field) => {
            const writer = writers.find(
              (entry) => FIELD_COLUMNS[field].includes(entry.column) && entry.type === 'human',
            )
            return { field, by: writer?.label ?? null, at: writer ? instant(writer.at) : null }
          }),
        },
      )
    }
  }

  const sets: SQL[] = []
  const before: Snapshot = {}
  const after: Snapshot = {}
  let video = row.expects_video
  let photos = row.expects_photos ? (row.photo_count ?? 1) : 0
  for (const field of changed) {
    before[FIELD_LABEL[field]] = words(currentValue(row, field))
    after[FIELD_LABEL[field]] = words(body[field])
  }
  if (body.buyer !== undefined) sets.push(sql`buyer_name = ${body.buyer || null}`)
  if (body.account !== undefined) {
    sets.push(sql`account_id = ${await accountIdOf(tx, model, body.account)}::uuid`)
  }
  if (body.brief !== undefined) sets.push(sql`brief = ${body.brief}`)
  if (body.duration_raw !== undefined) {
    const parsed = parseDuration(body.duration_raw)
    sets.push(sql`ordered_duration_raw = ${body.duration_raw.trim() || null},
                  duration_min_s = ${parsed?.min_s ?? null}, duration_max_s = ${parsed?.max_s ?? null}`)
  }
  if (body.wants_video !== undefined) video = body.wants_video
  if (body.wants_photos !== undefined) photos = body.wants_photos
  if (!video && photos === 0) {
    throw new ApiProblem('invalid_request', 'Нужно видео или фото', { field: 'wants_video' })
  }
  if (body.wants_video !== undefined || body.wants_photos !== undefined) {
    if (row.status === 'closed' || row.status === 'cancelled') requireOpen(row)
    // A part that is no longer ordered loses its mark; more photos than came — too.
    const photosHold = photos > 0 && row.live_photos >= photos
    sets.push(sql`expects_video = ${video}, expects_photos = ${photos > 0},
                  photo_count = ${photos > 0 ? photos : null},
                  video_completed_at = CASE WHEN ${video} THEN video_completed_at END,
                  video_completed_by = CASE WHEN ${video} THEN video_completed_by END,
                  photos_completed_at = CASE WHEN ${photosHold} THEN photos_completed_at END,
                  photos_completed_by = CASE WHEN ${photosHold} THEN photos_completed_by END`)
  }
  if (body.deadline !== undefined) sets.push(sql`due_at = ${dueAtOf(body.deadline)}::timestamptz`)
  if (body.fan_name !== undefined) sets.push(sql`name_in_media = ${body.fan_name}`)
  if (body.card_author !== undefined) sets.push(sql`card_author = ${body.card_author ?? ''}`)
  if (body.card_at) sets.push(sql`card_at = ${body.card_at}::timestamptz`)
  await domainRule(
    () =>
      tx.execute(sql`
        UPDATE custom_orders SET ${sql.join(sets, sql`, `)}, row_version = row_version + 1,
               updated_at = now()
         WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`),
    'order_closed',
  )
  await logOrder(tx, model, { id: row.id, brief: body.brief ?? row.brief }, { before, after })
}

// ---------------------------------------------------------------------------
// Parts and deliveries
// ---------------------------------------------------------------------------

function expects(row: OrderRow, part: OrderPartKind): boolean {
  return part === 'video' ? row.expects_video : row.expects_photos
}

/** The files that make the part whole now: a clip; photos — the ordered number (schema §9.2). */
function partHolds(row: OrderRow, part: OrderPartKind): boolean {
  return part === 'video' ? row.live_videos > 0 : row.live_photos >= (row.photo_count ?? 1)
}

async function setMark(
  tx: Tx,
  model: ModelScope,
  row: OrderRow,
  part: OrderPartKind,
  complete: boolean,
  actor: Actor,
): Promise<void> {
  const by = complete ? actor.id : null
  const assignment =
    part === 'video'
      ? sql`video_completed_at = CASE WHEN ${complete} THEN coalesce(video_completed_at, now()) END,
            video_completed_by = CASE WHEN ${complete} THEN coalesce(video_completed_by, ${by}::uuid) END`
      : sql`photos_completed_at = CASE WHEN ${complete} THEN coalesce(photos_completed_at, now()) END,
            photos_completed_by = CASE WHEN ${complete} THEN coalesce(photos_completed_by, ${by}::uuid) END`
  await domainRule(
    () =>
      tx.execute(sql`
        UPDATE custom_orders SET ${assignment}
         WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`),
    'order_not_complete',
  )
}

function missingPart(row: OrderRow, part: OrderPartKind): ApiProblem {
  if (part === 'video') {
    return new ApiProblem('order_not_complete', 'Не выполнено: видео по заказу ещё не сдано')
  }
  return new ApiProblem(
    'order_not_complete',
    `Не выполнено: фото ${row.live_photos} из ${row.photo_count ?? 1}`,
  )
}

/**
 * After the intake accepts a CUS with the order chosen (schema §5 «Принятие группы»): each
 * ordered part that now holds is marked — «Принять как сдачу» gives «заказ ✓» (DESIGN §6.6).
 * Several clips ordered: the person or the agent takes the mark back until all came.
 */
export async function markDeliveredParts(
  tx: Tx,
  model: ModelScope,
  orderId: string,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, orderId)
  if (row.status === 'closed' || row.status === 'cancelled') return
  let changed = false
  for (const part of ['video', 'photos'] as const) {
    const marked = (part === 'video' ? row.video_completed_at : row.photos_completed_at) !== null
    if (!expects(row, part) || marked || !partHolds(row, part)) continue
    await setMark(tx, model, row, part, true, actor)
    changed = true
  }
  if (changed) await touch(tx, model, row)
}

/** «Видео ✓»: the part is delivered whole, or not yet. */
export async function markPart(
  tx: Tx,
  model: ModelScope,
  address: string,
  part: string,
  complete: boolean,
  actor: Actor,
): Promise<void> {
  if (part !== 'video' && part !== 'photos') {
    throw new ApiProblem('not_found', 'Части бывают video и photos')
  }
  const row = await lockOrder(tx, model, address)
  requireOpen(row)
  if (!expects(row, part)) {
    throw new ApiProblem('invalid_request', `В заказе нет части «${PART_WORD[part]}»`, {
      field: 'part',
    })
  }
  const marked = (part === 'video' ? row.video_completed_at : row.photos_completed_at) !== null
  if (marked === complete) return
  if (complete && !partHolds(row, part)) throw missingPart(row, part)
  await setMark(tx, model, row, part, complete, actor)
  await touch(tx, model, row)
  await logOrder(tx, model, row, {
    before: { [`Часть «${PART_WORD[part]}»`]: marked ? 'сдана' : 'не сдана' },
    after: { [`Часть «${PART_WORD[part]}»`]: complete ? 'сдана' : 'не сдана' },
  })
}

interface PartFile extends Record<string, unknown> {
  membership_id: string
  asset_id: string
  version_id: string
  handle: string
  media_kind: 'video' | 'image'
}

/** Current versions of the CUS's own files: what a delivery seals. */
async function itemFiles(tx: Tx, model: ModelScope, itemId: string): Promise<PartFile[]> {
  const { rows } = await tx.execute<PartFile>(sql`
    SELECT im.id AS membership_id, a.id AS asset_id,
           coalesce(im.pinned_version_id, a.current_version_id) AS version_id,
           concat_ws('', im.role, lpad(im.ordinal::text, 2, '0'),
                     CASE WHEN im.variant_no > 0 THEN '_u' || im.variant_no END) AS handle,
           a.media_kind
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
     WHERE im.model_id = ${model.id}::uuid AND im.item_id = ${itemId}::uuid
       AND im.kind = 'owned' AND im.removed_at IS NULL AND im.role <> 'thumb'
       AND a.media_kind IN ('video', 'image')
     ORDER BY im.display_position NULLS LAST, im.added_at, im.id`)
  return rows
}

/** When the files appeared in the source: `remote_created_at`, else the upload; not acceptance. */
async function sourceTimeOf(
  tx: Tx,
  model: ModelScope,
  itemId: string,
  versionIds: readonly string[],
): Promise<string> {
  const { rows } = await tx.execute<{ at: string }>(sql`
    SELECT coalesce(
             (SELECT min(coalesce(sr.remote_created_at, sr.detected_at))
                FROM asset_versions v
                JOIN source_revisions sr ON sr.model_id = v.model_id AND sr.id = v.source_revision_id
               WHERE v.model_id = ${model.id}::uuid AND v.id = ANY(${sql.param([...versionIds])}::uuid[])),
             (SELECT created_at FROM content_items
               WHERE model_id = ${model.id}::uuid AND id = ${itemId}::uuid)
           )::text AS at`)
  return rows[0]?.at ?? new Date().toISOString()
}

/** A live delivery of the same CUS and part with the same versions: a repeat links nothing. */
async function sameLiveDelivery(
  tx: Tx,
  model: ModelScope,
  orderId: string,
  itemId: string,
  part: OrderPartKind,
  versionIds: readonly string[],
): Promise<boolean> {
  const { rows } = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM custom_order_deliveries d
       WHERE d.model_id = ${model.id}::uuid AND d.order_id = ${orderId}::uuid
         AND d.item_id = ${itemId}::uuid AND d.part = ${part} AND d.retracts_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id)
         AND (SELECT array_agg(e.asset_version_id ORDER BY e.asset_version_id)
                FROM asset_manifest_entries e
               WHERE e.model_id = d.model_id AND e.manifest_id = d.manifest_id)
             = (SELECT array_agg(v ORDER BY v) FROM unnest(${sql.param([...versionIds])}::uuid[]) v)
    ) AS found`)
  return rows[0]?.found === true
}

async function addMessageRow(
  tx: Tx,
  model: ModelScope,
  orderId: string,
  message: { ref: string; kind: string; at: string; author: string; excerpt: string },
  actor: Actor,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO custom_order_messages (model_id, order_id, tg_ref, kind, message_at, author,
                                       excerpt, recorded_by)
    VALUES (${model.id}::uuid, ${orderId}::uuid, ${message.ref}, ${message.kind},
            ${message.at}::timestamptz, ${message.author}, ${message.excerpt}, ${actor.id}::uuid)
    ON CONFLICT ON CONSTRAINT custom_order_messages_ref DO NOTHING
    RETURNING id`)
  return rows.length > 0
}

/**
 * A delivery of an accepted CUS (SPEC §8.2): per part, a sealed composition of the current
 * versions of its files, the source date, the signals and, when the link was ambiguous, the
 * confirmation. The part's mark follows: video — the clip came (unless more clips are
 * expected: `complete: false`), photos — when the ordered number came.
 */
export async function linkDelivery(
  tx: Tx,
  model: ModelScope,
  address: string,
  body: LinkDeliveryCommand,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  requireOpen(row)
  const item = await findItem(tx, model, body.item_id)
  if (item.type !== 'CUS') {
    throw new ApiProblem('invalid_request', 'Сдача по заказу — это кастом (CUS)', {
      field: 'item_id',
    })
  }
  await setJournalItem(tx, item.id)
  const files = await itemFiles(tx, model, item.id)
  const ofPart = (part: OrderPartKind) =>
    files.filter((file) => file.media_kind === (part === 'video' ? 'video' : 'image'))
  if (body.part && !expects(row, body.part)) {
    throw new ApiProblem('invalid_request', `В заказе нет части «${PART_WORD[body.part]}»`, {
      field: 'part',
    })
  }
  const parts: OrderPartKind[] = body.part
    ? [body.part]
    : (['video', 'photos'] as const).filter((part) => expects(row, part) && ofPart(part).length > 0)
  const itemId: ItemId = publicIdOfRow(item)
  if (parts.length === 0 || parts.some((part) => ofPart(part).length === 0)) {
    throw new ApiProblem(
      'order_not_complete',
      `В ${itemId} нет файлов той части, что заказана: ${wantsWords(row.expects_video, row.expects_photos ? 1 : 0)}`,
      { item_id: itemId },
    )
  }
  const matched = body.matched?.length ? body.matched : ['привязано вручную']
  const confirmedBy = body.confirmed ? actor.id : null
  const linked: OrderPartKind[] = []
  for (const part of parts) {
    const chosen = ofPart(part)
    const versionIds = chosen.map((file) => file.version_id)
    if (await sameLiveDelivery(tx, model, row.id, item.id, part, versionIds)) continue
    const deliveredAt = body.delivered_at ?? (await sourceTimeOf(tx, model, item.id, versionIds))
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
    await domainRule(
      () =>
        tx.execute(sql`
          INSERT INTO custom_order_deliveries (model_id, order_id, part, item_id, manifest_id,
                                               delivered_at, basis, evidence_refs, linked_by,
                                               confirmed_by)
          VALUES (${model.id}::uuid, ${row.id}::uuid, ${part}, ${item.id}::uuid,
                  ${manifestId}::uuid, ${deliveredAt}::timestamptz,
                  ${JSON.stringify({ signals: matched, via: 'api' })}::jsonb,
                  ${JSON.stringify((body.evidence ?? []).map(messageRef))}::jsonb,
                  ${actor.id}::uuid, ${confirmedBy}::uuid)`),
      'order_closed',
    )
    linked.push(part)
    if (body.message_url) {
      await addMessageRow(
        tx,
        model,
        row.id,
        {
          ref: messageRef(body.message_url),
          kind: 'delivery',
          at: deliveredAt,
          author: actor.name,
          excerpt: `Сдача ${itemId} · ${PART_WORD[part]}`,
        },
        actor,
      )
    }
  }
  if (linked.length === 0) return
  const fresh = await reread(tx, model, row.id)
  for (const part of linked) {
    const marked =
      (part === 'video' ? fresh.video_completed_at : fresh.photos_completed_at) !== null
    const wanted = body.complete ?? partHolds(fresh, part)
    if (wanted && !marked) {
      if (!partHolds(fresh, part)) throw missingPart(fresh, part)
      await setMark(tx, model, fresh, part, true, actor)
    }
    if (body.complete === false && marked) await setMark(tx, model, fresh, part, false, actor)
  }
  await touch(tx, model, row)
  await logOrder(tx, model, row, {
    itemId: item.id,
    after: {
      Сдача: `${itemId} · ${linked.map((part) => PART_WORD[part]).join(' и ')}`,
      Совпало: matched.join(', '),
      ...(confirmedBy ? { Подтверждено: actor.type === 'agent' ? 'агентом' : actor.name } : {}),
    },
  })
}

/** «Отвязать…»: a new record retracts the delivery; the mark comes back if the part still holds. */
export async function retractDelivery(
  tx: Tx,
  model: ModelScope,
  address: string,
  deliveryId: string,
  reason: string,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  requireOpen(row)
  const isUuid = /^[0-9a-f-]{36}$/i.test(deliveryId)
  const { rows } = isUuid
    ? await tx.execute<{
        id: string
        part: OrderPartKind
        item_id: string
        retracts_id: string | null
        retracted: boolean
      }>(sql`
        SELECT d.id, d.part, d.item_id, d.retracts_id,
               EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id) AS retracted
          FROM custom_order_deliveries d
         WHERE d.model_id = ${model.id}::uuid AND d.order_id = ${row.id}::uuid
           AND d.id = ${deliveryId}::uuid`)
    : { rows: [] }
  const delivery = rows[0]
  if (!delivery || delivery.retracts_id !== null) {
    throw new ApiProblem('not_found', 'Такой сдачи у заказа нет')
  }
  if (delivery.retracted) return
  const marked =
    (delivery.part === 'video' ? row.video_completed_at : row.photos_completed_at) !== null
  await setJournalItem(tx, delivery.item_id)
  await domainRule(
    () =>
      tx.execute(sql`
        INSERT INTO custom_order_deliveries (model_id, order_id, retracts_id, retract_reason,
                                             linked_by)
        VALUES (${model.id}::uuid, ${row.id}::uuid, ${delivery.id}::uuid, ${reason},
                ${actor.id}::uuid)`),
    'order_closed',
  )
  const fresh = await reread(tx, model, row.id)
  if (marked && partHolds(fresh, delivery.part)) {
    await setMark(tx, model, fresh, delivery.part, true, actor)
  }
  await touch(tx, model, row)
  const { rows: items } = await tx.execute<{ type: string; number: number }>(sql`
    SELECT type, number FROM content_items
     WHERE model_id = ${model.id}::uuid AND id = ${delivery.item_id}::uuid`)
  const item = items[0]
  await logOrder(tx, model, row, {
    itemId: delivery.item_id,
    after: {
      'Сдача отвязана': item
        ? publicIdOfRow({ type: item.type as never, number: item.number })
        : '—',
      Причина: reason,
    },
  })
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** A requirement of a revision (SPEC §8.2); the same message and text again is a repeat. */
export async function addRevision(
  tx: Tx,
  model: ModelScope,
  address: string,
  body: AddRevisionCommand,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  requireOpen(row)
  const ref = body.message_url ? messageRef(body.message_url) : `manual:${randomUUID()}`
  const { rows: same } = await tx.execute<{ request_ordinal: number; requirement: string }>(sql`
    SELECT request_ordinal, requirement FROM custom_order_revisions
     WHERE model_id = ${model.id}::uuid AND order_id = ${row.id}::uuid AND request_tg_ref = ${ref}
     ORDER BY request_ordinal`)
  if (body.ordinal !== undefined && same.some((entry) => entry.request_ordinal === body.ordinal)) {
    return
  }
  if (body.ordinal === undefined && same.some((entry) => entry.requirement === body.text)) return
  const ordinal = body.ordinal ?? (same.at(-1)?.request_ordinal ?? 0) + 1
  const { rows } = await tx.execute<{ requested_at: string }>(sql`
    INSERT INTO custom_order_revisions (model_id, order_id, requirement, request_tg_ref,
                                        request_ordinal, requested_at, created_by)
    VALUES (${model.id}::uuid, ${row.id}::uuid, ${body.text}, ${ref}, ${ordinal},
            coalesce(${body.requested_at ?? null}::timestamptz, now()), ${actor.id}::uuid)
    RETURNING requested_at::text AS requested_at`)
  if (body.message_url && parseTelegramRef(body.message_url)) {
    await addMessageRow(
      tx,
      model,
      row.id,
      {
        ref,
        kind: 'revision',
        at: rows[0]?.requested_at ?? new Date().toISOString(),
        author: actor.name,
        excerpt: body.text,
      },
      actor,
    )
  }
  await touch(tx, model, row)
  await logOrder(tx, model, row, { after: { Правка: body.text } })
}

interface RevisionRef extends Record<string, unknown> {
  id: string
  requirement: string
  requested_at: string
  done: boolean
  done_basis: string | null
  fixed_delivery_id: string | null
}

async function lockRevision(tx: Tx, model: ModelScope, row: OrderRow, id: string) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(id)
  const { rows } = isUuid
    ? await tx.execute<RevisionRef>(sql`
        SELECT id, requirement, requested_at::text AS requested_at, done, done_basis,
               fixed_delivery_id
          FROM custom_order_revisions
         WHERE model_id = ${model.id}::uuid AND order_id = ${row.id}::uuid AND id = ${id}::uuid
         FOR UPDATE`)
    : { rows: [] }
  const revision = rows[0]
  if (!revision) throw new ApiProblem('not_found', 'Такой правки у заказа нет')
  return revision
}

/**
 * «Выполнена»: checked by a person, or a new version — the delivery that fixed it, the last
 * live one after the request when not named. Linking a version alone never closes a revision.
 */
export async function completeRevision(
  tx: Tx,
  model: ModelScope,
  address: string,
  revisionId: string,
  body: CompleteRevisionCommand,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  if (row.status === 'cancelled') requireOpen(row)
  const revision = await lockRevision(tx, model, row, revisionId)
  let fixed: string | null = null
  if (body.delivery_id || body.basis === 'new_version') {
    const named =
      body.delivery_id && /^[0-9a-f-]{36}$/i.test(body.delivery_id) ? body.delivery_id : null
    if (body.delivery_id && !named) throw new ApiProblem('not_found', 'Такой сдачи у заказа нет')
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT d.id FROM custom_order_deliveries d
       WHERE d.model_id = ${model.id}::uuid AND d.order_id = ${row.id}::uuid
         AND d.retracts_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id)
         AND (${named}::uuid IS NULL OR d.id = ${named}::uuid)
         AND (${named}::uuid IS NOT NULL OR d.linked_at >= ${revision.requested_at}::timestamptz)
       ORDER BY d.linked_at DESC, d.id DESC LIMIT 1`)
    fixed = rows[0]?.id ?? null
    if (!fixed) {
      throw new ApiProblem(
        'order_not_complete',
        named
          ? 'Такой действующей сдачи у заказа нет'
          : 'Не выполнено: после правки новой сдачи нет',
      )
    }
  }
  if (revision.done && revision.done_basis === body.basis && revision.fixed_delivery_id === fixed) {
    return
  }
  await tx.execute(sql`
    UPDATE custom_order_revisions
       SET done = true, done_at = now(), done_by = ${actor.id}::uuid, done_basis = ${body.basis},
           fixed_delivery_id = ${fixed}::uuid, row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${revision.id}::uuid`)
  await touch(tx, model, row)
  await logOrder(tx, model, row, {
    after: {
      'Правка выполнена': revision.requirement,
      Основание: body.basis === 'new_version' ? 'новая версия' : 'проверено',
    },
  })
}

export async function reopenRevision(
  tx: Tx,
  model: ModelScope,
  address: string,
  revisionId: string,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  requireOpen(row)
  const revision = await lockRevision(tx, model, row, revisionId)
  if (!revision.done) return
  await domainRule(
    () =>
      tx.execute(sql`
        UPDATE custom_order_revisions
           SET done = false, done_at = NULL, done_by = NULL, done_basis = NULL,
               fixed_delivery_id = NULL, reopened_at = now(), row_version = row_version + 1,
               updated_at = now()
         WHERE model_id = ${model.id}::uuid AND id = ${revision.id}::uuid`),
    'order_closed',
  )
  await touch(tx, model, row)
  await logOrder(tx, model, row, { after: { 'Правка открыта снова': revision.requirement } })
}

// ---------------------------------------------------------------------------
// Messages, closing and cancelling
// ---------------------------------------------------------------------------

/** A significant message; the same message of the same kind again is a repeat. */
export async function addOrderMessage(
  tx: Tx,
  model: ModelScope,
  address: string,
  body: AddOrderMessageCommand,
  actor: Actor,
): Promise<void> {
  const row = await lockOrder(tx, model, address)
  const added = await addMessageRow(
    tx,
    model,
    row.id,
    {
      ref: messageRef(body.message_url),
      kind: body.kind,
      at: body.at,
      author: body.author,
      excerpt: body.excerpt,
    },
    actor,
  )
  if (!added) return
  await touch(tx, model, row)
  await logOrder(tx, model, row, { after: { Сообщение: `${body.kind}: ${body.excerpt}` } })
}

/** Only a delivered order without open revisions (SPEC §5); closing twice is a repeat. */
export async function closeOrder(tx: Tx, model: ModelScope, address: string, actor: Actor) {
  const row = await lockOrder(tx, model, address)
  if (row.status === 'closed') return
  requireOpen(row)
  const missing = (['video', 'photos'] as const).filter(
    (part) =>
      expects(row, part) &&
      (part === 'video' ? row.video_completed_at : row.photos_completed_at) === null,
  )
  if (missing.length > 0) {
    throw new ApiProblem(
      'order_not_complete',
      `Не выполнено: ещё не всё сдано — ${missing.map((part) => PART_WORD[part]).join(', ')}`,
    )
  }
  const { rows } = await tx.execute<{ open: number }>(sql`
    SELECT count(*)::int AS open FROM custom_order_revisions
     WHERE model_id = ${model.id}::uuid AND order_id = ${row.id}::uuid AND NOT done`)
  if ((rows[0]?.open ?? 0) > 0) {
    throw new ApiProblem('order_not_complete', 'Не выполнено: сначала отметьте правку выполненной')
  }
  await domainRule(
    () =>
      tx.execute(sql`
        UPDATE custom_orders SET status = 'closed', closed_at = now(), closed_by = ${actor.id}::uuid,
               row_version = row_version + 1, updated_at = now()
         WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`),
    'order_not_complete',
  )
  await logOrder(tx, model, row, { after: { Заказ: 'закрыт' } })
}

/** «Снять…» with a reason: the order will not be delivered; no overdue from now on. */
export async function cancelOrder(
  tx: Tx,
  model: ModelScope,
  address: string,
  reason: string,
  actor: Actor,
) {
  const row = await lockOrder(tx, model, address)
  if (row.status === 'cancelled') return
  if (row.status === 'closed') {
    throw new ApiProblem('order_closed', 'Не выполнено: заказ уже закрыт')
  }
  await tx.execute(sql`
    UPDATE custom_orders SET status = 'cancelled', cancelled_at = now(),
           cancelled_by = ${actor.id}::uuid, cancel_reason = ${reason},
           row_version = row_version + 1, updated_at = now()
     WHERE model_id = ${model.id}::uuid AND id = ${row.id}::uuid`)
  await logOrder(tx, model, row, { after: { Заказ: 'снят', Причина: reason } })
}
