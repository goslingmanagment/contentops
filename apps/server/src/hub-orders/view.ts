import { mskDate } from '@contentops/contracts/clock'
import type { ActorRef, Instant, StatusWord } from '@contentops/contracts/domain/common'
import {
  HUB_PRODUCTION_STATES,
  type HubOrder,
  type HubOrderFile,
  type HubOrderList,
  type HubOrderMessage,
  type HubReport,
} from '@contentops/contracts/domain/hub-orders'
import type { OrderPartKind } from '@contentops/contracts/domain/orders'
import type { Role } from '@contentops/contracts/domain/people'
import { formatDate, plural } from '@contentops/contracts/format'
import { orderAddress, parseTelegramRef, telegramUrlOf } from '@contentops/contracts/order-link'
import type { Queryable } from '@contentops/db'
import type { HubCustomOrder } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { publicIdOf } from '../catalog/ids'
import { instant, instantOrNull } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { actorRefs, orderViews } from '../orders/view'

/**
 * The hub's orders in production as ContentOps' cards (ecosystem plan 12.11.2026, package N):
 * the last read of the hub (`hub_order_reads`), the files ContentOps holds for each
 * (`hub_order_deliveries`, and the deliveries of its old order in the archive), and what the
 * hub knows of them (`hub_order_reports`). Never a live call: the hub may be away (a deploy).
 */

export interface HubOrderContext {
  model: ModelScope & { genitive: string }
  role: Role
  /** The hub's console (`HUB_BASE_URL`); `null` — not configured. */
  hubBase: string | null
  now?: Instant
}

export interface HubOrderRead {
  read_at: string | null
  orders: HubCustomOrder[]
  unassigned: number
  tried_at: string | null
  error: string | null
}

const DAYS: readonly [string, string, string] = ['день', 'дня', 'дней']
const PART_WORD: Record<OrderPartKind, string> = { video: 'видео', photos: 'фото' }

export async function readHubOrders(q: Queryable, modelId: string): Promise<HubOrderRead> {
  const { rows } = await q.execute<HubOrderRead & Record<string, unknown>>(sql`
    SELECT read_at::text AS read_at, orders, unassigned, tried_at::text AS tried_at, error
      FROM hub_order_reads WHERE model_id = ${modelId}::uuid`)
  return rows[0] ?? { read_at: null, orders: [], unassigned: 0, tried_at: null, error: null }
}

/** The hub's board «Кастомы»: where an order is made, moved, given and closed. */
export function boardUrl(hubBase: string | null, code?: string): string | null {
  if (!hubBase) return null
  const base = hubBase.replace(/\/+$/, '')
  return code ? `${base}/workboard/customs/${code}` : `${base}/workboard/customs`
}

/** «Hub не ответил 12:04» — what the screen says while the hub is away. */
function readError(read: HubOrderRead): string | null {
  if (!read.error) return null
  return read.error
}

/** What the card asks for: a video unless it says none, photos when it names how many. */
function wantsOf(order: HubCustomOrder): { video: boolean; photos: number } {
  const video = order.card.wantsVideo !== false
  const photos = order.card.wantsPhotos ?? 0
  return !video && photos === 0 ? { video: false, photos: 1 } : { video, photos }
}

function statusOf(order: HubCustomOrder, pending: number, now: Instant): StatusWord {
  const today = mskDate(now)
  const overdue = order.overdueDays
  const late = overdue !== null ? `${overdue} ${plural(overdue, DAYS)}` : null
  let status: StatusWord
  switch (order.state) {
    case 'revision':
      status = {
        sign: 'turn',
        word: 'правка',
        detail: order.stateNote ? `«${order.stateNote}»` : null,
      }
      break
    case 'shot':
      status = { sign: 'done', word: 'снято', detail: 'отдать фану в Hub' }
      break
    case 'partly':
      status = late
        ? { sign: 'trouble', word: 'просрочено', detail: `сдано частично · ${late}` }
        : { sign: null, word: 'сдано частично', detail: order.stateNote }
      break
    default:
      status = late
        ? { sign: 'trouble', word: 'просрочено', detail: late }
        : {
            sign: null,
            word: 'у модели',
            detail: order.deadlineOn ? `до ${formatDate(order.deadlineOn, today)}` : null,
          }
  }
  if (pending > 0) {
    // The hub is the home: until it has the delivery, nothing here says it is delivered.
    const note = 'сдача ещё не в Hub'
    status = { ...status, detail: status.detail ? `${status.detail} · ${note}` : note }
  }
  return status
}

interface DeliveryRow extends Record<string, unknown> {
  id: string
  order_code: string
  part: OrderPartKind
  complete: boolean
  type: string
  number: number
  files: number
  message_ref: string | null
  delivered_at: string
  linked_at: string
  linked_by: string | null
  retraction_id: string | null
  retracted_at: string | null
  retracted_by: string | null
  retract_reason: string | null
}

interface ReportRow extends Record<string, unknown> {
  delivery_id: string
  state: 'pending' | 'sent' | 'refused'
  tried_at: string | null
  sent_at: string | null
  error: string | null
  outcome: string | null
}

async function deliveriesOf(q: Queryable, modelId: string, codes: readonly string[]) {
  if (codes.length === 0) return { deliveries: [] as DeliveryRow[], reports: new Map() }
  const { rows } = await q.execute<DeliveryRow>(sql`
    SELECT d.id, d.order_code, d.part, d.complete, c.type, c.number, m.entry_count AS files,
           d.message_ref, d.delivered_at::text AS delivered_at, d.linked_at::text AS linked_at,
           d.linked_by, r.id AS retraction_id, r.linked_at::text AS retracted_at,
           r.linked_by AS retracted_by, r.retract_reason
      FROM hub_order_deliveries d
      JOIN content_items c ON c.model_id = d.model_id AND c.id = d.item_id
      JOIN asset_manifests m ON m.model_id = d.model_id AND m.id = d.manifest_id
      LEFT JOIN hub_order_deliveries r ON r.model_id = d.model_id AND r.retracts_id = d.id
     WHERE d.model_id = ${modelId}::uuid AND d.retracts_id IS NULL
       AND d.order_code = ANY(${sql.param([...codes])}::text[])
     ORDER BY d.delivered_at, d.id`)
  const ids = rows.flatMap((row) => [row.id, ...(row.retraction_id ? [row.retraction_id] : [])])
  const { rows: reports } =
    ids.length === 0
      ? { rows: [] as ReportRow[] }
      : await q.execute<ReportRow>(sql`
          SELECT delivery_id, state, tried_at::text AS tried_at, sent_at::text AS sent_at, error,
                 outcome
            FROM hub_order_reports
           WHERE model_id = ${modelId}::uuid AND delivery_id = ANY(${sql.param(ids)}::uuid[])`)
  return { deliveries: rows, reports: new Map(reports.map((row) => [row.delivery_id, row])) }
}

function reportView(row: ReportRow | undefined): HubReport | null {
  if (!row) return null
  return {
    state: row.state,
    at: instantOrNull(row.sent_at ?? row.tried_at),
    error: row.error,
    unchanged: row.state === 'sent' && row.outcome === 'unchanged',
  }
}

/** An instant of the hub's answer, or `null` when it gave none. */
function hubInstant(value: string | null | undefined): Instant | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const UNKNOWN_ACTOR: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

/** ContentOps' old order of the same card: the import's `contentopsRef`, else a shared card. */
async function archiveOrders(
  q: Queryable,
  model: ModelScope,
  orders: readonly HubCustomOrder[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const byCard = new Map<string, string>()
  for (const order of orders) {
    const ref = order.contentopsRef
    if (ref?.startsWith(`${model.code}/`)) {
      found.set(order.code, ref.slice(model.code.length + 1))
      continue
    }
    for (const card of order.telegramRefs) {
      const parsed = parseTelegramRef(card)
      if (parsed) byCard.set(orderAddress(parsed), order.code)
    }
  }
  if (byCard.size === 0) return found
  const { rows } = await q.execute<{ address: string }>(sql`
    SELECT 'tg-' || tg_chat || coalesce('-' || tg_topic::text, '') || '-' || tg_message_id::text
             AS address
      FROM custom_orders
     WHERE model_id = ${model.id}::uuid
       AND ('tg-' || tg_chat || coalesce('-' || tg_topic::text, '') || '-' || tg_message_id::text)
           = ANY(${sql.param([...byCard.keys()])}::text[])`)
  for (const row of rows) {
    const code = byCard.get(row.address)
    if (code && !found.has(code)) found.set(code, row.address)
  }
  return found
}

function messageView(
  message: HubCustomOrder['messages'][number],
  reader: boolean,
): HubOrderMessage {
  return {
    kind: message.kind,
    part: message.part,
    at: hubInstant(message.at),
    author: message.author,
    excerpt: reader ? null : message.excerpt,
    url: reader ? null : telegramUrlOf(message.telegramRef),
    done_at: hubInstant(message.doneAt),
  }
}

/**
 * The cards of the model: the hub's orders in production, the oldest step first. `code` — one
 * order, also when it left production (the card stays reachable by its address).
 */
export async function hubOrderViews(
  q: Queryable,
  context: HubOrderContext,
  options: { code?: string } = {},
): Promise<{ read: HubOrderRead; items: HubOrder[] }> {
  const now = context.now ?? new Date().toISOString()
  const read = await readHubOrders(q, context.model.id)
  const orders = read.orders.filter((order) =>
    options.code ? order.code === options.code : HUB_PRODUCTION_STATES.includes(order.state),
  )
  const codes = orders.map((order) => order.code)
  const { rows: accounts } = await q.execute<{ code: string; hub: string }>(sql`
    SELECT code, hub_page_ref AS hub FROM accounts
     WHERE model_id = ${context.model.id}::uuid AND hub_page_ref IS NOT NULL`)
  const accountOf = new Map(accounts.map((row) => [row.hub, row.code]))
  const { deliveries, reports } = await deliveriesOf(q, context.model.id, codes)
  const archive = await archiveOrders(q, context.model, orders)
  const archived =
    archive.size === 0
      ? []
      : (
          await orderViews(
            q,
            { model: context.model, role: context.role, now },
            sql`('tg-' || o.tg_chat || coalesce('-' || o.tg_topic::text, '') || '-'
                 || o.tg_message_id::text) = ANY(${sql.param([...new Set(archive.values())])}::text[])`,
          )
        ).orders
  const archivedById = new Map(archived.map((order) => [order.id, order]))
  const people = await actorRefs(
    q,
    deliveries.flatMap((row) => [row.linked_by, row.retracted_by].filter((id) => id !== null)),
  )
  const actor = (id: string | null) => (id ? (people.get(id) ?? UNKNOWN_ACTOR) : UNKNOWN_ACTOR)
  const reader = context.role === 'reader'

  const items = orders.map((order): HubOrder => {
    const own = deliveries.filter((row) => row.order_code === order.code)
    const files: HubOrderFile[] = own.map((row) => ({
      id: row.id,
      item_id: publicIdOf(row.type, row.number),
      part: row.part,
      complete: row.complete,
      files: row.files,
      delivered_at: instant(row.delivered_at),
      linked_at: instant(row.linked_at),
      linked_by: actor(row.linked_by),
      message_url: reader || !row.message_ref ? null : telegramUrlOf(row.message_ref),
      retracted: row.retraction_id
        ? {
            at: instant(row.retracted_at ?? row.linked_at),
            by: actor(row.retracted_by),
            reason: reader ? null : row.retract_reason,
          }
        : null,
      archive_order: null,
      report: reportView(reports.get(row.id)),
      retraction_report: row.retraction_id ? reportView(reports.get(row.retraction_id)) : null,
    }))
    const archiveAddress = archive.get(order.code) ?? null
    const old = archiveAddress ? archivedById.get(archiveAddress) : undefined
    for (const delivery of old?.deliveries ?? []) {
      files.push({
        id: delivery.id,
        item_id: delivery.item_id,
        part: delivery.part,
        complete: old?.parts.find((part) => part.kind === delivery.part)?.complete ?? false,
        files: delivery.files,
        delivered_at: delivery.delivered_at,
        linked_at: delivery.at,
        linked_by: delivery.linked_by,
        message_url: null,
        retracted: delivery.retracted,
        archive_order: archiveAddress,
        report: null,
        retraction_report: null,
      })
    }
    const pending = files.filter(
      (file) => file.report?.state === 'pending' || file.retraction_report?.state === 'pending',
    ).length
    const wants = wantsOf(order)
    const card = order.telegramRefs[0] ?? null
    return {
      code: order.code,
      state: order.state,
      state_at: hubInstant(order.stateAt) ?? now,
      status: statusOf(order, pending, now),
      title: order.what || order.card.task?.split('\n')[0] || order.code,
      account: order.pageLabel ? (accountOf.get(order.pageLabel) ?? null) : null,
      hub_page: order.pageLabel,
      buyer: reader ? null : (order.fan?.username ?? order.fan?.displayName ?? order.buyer),
      card_text: reader ? null : order.cardText || order.sourceText,
      duration: order.card.duration ?? null,
      deadline: order.deadlineOn,
      overdue_days: order.overdueDays !== null && order.overdueDays > 0 ? order.overdueDays : null,
      wants_video: wants.video,
      wants_photos: wants.photos,
      parts_done: order.partsDone,
      open_revisions: order.openRevisions,
      messages: order.messages
        .map((message) => messageView(message, reader))
        .sort((left, right) => (right.at ?? '').localeCompare(left.at ?? '')),
      card_url: reader || !card ? null : telegramUrlOf(card),
      hub_url: boardUrl(context.hubBase, order.code),
      archive_order: archiveAddress,
      files,
      pending_reports: pending,
      version: order.version,
    }
  })
  return { read, items: items.sort(byStep) }
}

/** A revision first, then the overdue, then the oldest step. */
const STEP_RANK: Partial<Record<HubOrder['state'], number>> = {
  revision: 0,
  at_model: 2,
  partly: 2,
  shot: 3,
}
function byStep(left: HubOrder, right: HubOrder): number {
  const rank = (order: HubOrder) =>
    order.overdue_days !== null ? 1 : (STEP_RANK[order.state] ?? 4)
  return rank(left) - rank(right) || left.state_at.localeCompare(right.state_at)
}

export async function hubOrderList(
  q: Queryable,
  context: HubOrderContext,
  options: { configured: boolean },
): Promise<HubOrderList> {
  const { read, items } = await hubOrderViews(q, context)
  const { rows } = await q.execute<{ busy: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM work_operations
       WHERE model_id = ${context.model.id}::uuid AND kind = 'hub_orders'
         AND state IN ('pending', 'running', 'retry_wait')
    ) AS busy`)
  return {
    items,
    configured: options.configured,
    read_at: instantOrNull(read.read_at),
    read_error: readError(read),
    refreshing: rows[0]?.busy === true,
    unassigned: read.unassigned,
    board_url: boardUrl(context.hubBase),
  }
}

export async function hubOrderView(
  q: Queryable,
  context: HubOrderContext,
  code: string,
): Promise<HubOrder> {
  const { items } = await hubOrderViews(q, context, { code })
  const order = items[0]
  if (!order) {
    throw new ApiProblem('not_found', `Заказа ${code} в последнем чтении Hub у этой модели нет`)
  }
  return order
}

/** What a delivery says to the hub, in a line of the order's messages. */
export function deliveryExcerpt(item: string, part: OrderPartKind, files: number): string {
  const count = `${files} ${plural(files, ['файл', 'файла', 'файлов'])}`
  return `ContentOps: ${item} · ${PART_WORD[part]} · ${count}`
}
