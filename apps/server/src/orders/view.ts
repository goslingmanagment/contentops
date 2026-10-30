import {
  addDays,
  daysBetween,
  instantFromMs,
  mskDate,
  mskInstant,
} from '@contentops/contracts/clock'
import type { ActorRef, Instant, LocalDate } from '@contentops/contracts/domain/common'
import type {
  Order,
  OrderDelivery,
  OrderMessage,
  OrderPart,
  OrderPartKind,
  OrderRevision,
  RevisionBasis,
} from '@contentops/contracts/domain/orders'
import type { Role } from '@contentops/contracts/domain/people'
import { formatSpan, minutesBetween } from '@contentops/contracts/format'
import { orderTitleOf } from '@contentops/contracts/order-card'
import {
  orderAddress,
  parseTelegramRef,
  type TelegramMessageRef,
  telegramRefText,
  telegramUrl,
  telegramUrlOf,
} from '@contentops/contracts/order-link'
import { computeOrderStatus, overdueDaysOf } from '@contentops/contracts/order-status'
import type { Queryable } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { publicIdOf } from '../catalog/ids'
import { instant, instantOrNull } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'

/**
 * Orders as the API gives them (SPEC §8.2, DESIGN §4.16, §5.5): the stored order with its
 * deliveries, revisions and messages, and what the server computes from them — the parts, the
 * state word, overdue by the delivery dates in the source and «Сдано, требуется правка».
 */

export interface OrderRow extends Record<string, unknown> {
  id: string
  account_code: string | null
  tg_chat: string
  tg_topic: string | null
  tg_message_id: string
  card_author: string
  card_at: string
  buyer_name: string | null
  brief: string
  ordered_duration_raw: string | null
  duration_min_s: number | null
  duration_max_s: number | null
  expects_video: boolean
  expects_photos: boolean
  photo_count: number | null
  due_at: string | null
  status: 'open' | 'delivered' | 'closed' | 'cancelled'
  name_in_media: 'yes' | 'no' | 'unknown'
  video_completed_at: string | null
  video_completed_by: string | null
  photos_completed_at: string | null
  photos_completed_by: string | null
  closed_at: string | null
  closed_by: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_by: string | null
  row_version: number
  live_videos: number
  live_photos: number
}

export const ORDER_COLUMNS = sql`
  o.id, a.code AS account_code, o.tg_chat, o.tg_topic::text AS tg_topic,
  o.tg_message_id::text AS tg_message_id, o.card_author, o.card_at::text AS card_at,
  o.buyer_name, o.brief, o.ordered_duration_raw, o.duration_min_s, o.duration_max_s,
  o.expects_video, o.expects_photos, o.photo_count, o.due_at::text AS due_at, o.status,
  o.name_in_media, o.video_completed_at::text AS video_completed_at, o.video_completed_by,
  o.photos_completed_at::text AS photos_completed_at, o.photos_completed_by,
  o.closed_at::text AS closed_at, o.closed_by, o.cancelled_at::text AS cancelled_at,
  o.cancelled_by, o.cancel_reason, o.created_by, o.row_version::int AS row_version,
  custom_order_live_files(o.model_id, o.id, 'video') AS live_videos,
  custom_order_live_files(o.model_id, o.id, 'photos') AS live_photos`

export const ORDER_FROM = sql`
  custom_orders o LEFT JOIN accounts a ON a.model_id = o.model_id AND a.id = o.account_id`

interface DeliveryRow extends Record<string, unknown> {
  id: string
  order_id: string
  part: OrderPartKind
  item_type: string
  item_number: number
  delivered_at: string
  basis: unknown
  evidence_refs: unknown
  linked_at: string
  linked_by: string | null
  confirmed_by: string | null
  retracted_at: string | null
  retracted_by: string | null
  retract_reason: string | null
  files: number
  duration_ms: string | null
}

interface RevisionRow extends Record<string, unknown> {
  id: string
  order_id: string
  requirement: string
  request_tg_ref: string
  requested_at: string
  done: boolean
  done_basis: string | null
  fixed_delivery_id: string | null
  fixed_item_type: string | null
  fixed_item_number: number | null
  done_at: string | null
  done_by: string | null
  created_by: string | null
}

interface MessageRow extends Record<string, unknown> {
  order_id: string
  tg_ref: string
  kind: OrderMessage['kind']
  message_at: string
  author: string
  excerpt: string
}

interface InboxRow extends Record<string, unknown> {
  order_id: string
  media_kind: 'video' | 'image' | null
  path: string | null
  arrived_at: string
}

interface PrincipalRow extends Record<string, unknown> {
  id: string
  kind: 'human' | 'agent'
  display_name: string
  gender: 'f' | 'm' | null
}

/** The card of an order row. */
export function cardRefOf(row: Pick<OrderRow, 'tg_chat' | 'tg_topic' | 'tg_message_id'>) {
  return {
    chat: row.tg_chat,
    topic: row.tg_topic === null ? null : Number(row.tg_topic),
    message: Number(row.tg_message_id),
  } satisfies TelegramMessageRef
}

export function addressOf(row: Pick<OrderRow, 'tg_chat' | 'tg_topic' | 'tg_message_id'>) {
  return orderAddress(cardRefOf(row))
}

/** «Кастом «вся в красном»» in the journal and the toasts. */
export function orderLabel(row: Pick<OrderRow, 'brief'>): string {
  return `Кастом «${orderTitleOf(row.brief)}»`
}

/** «до 19.09» is the end of that day in Moscow: the deadline in the database. */
export function dueAtOf(deadline: LocalDate | null): string | null {
  return deadline ? mskInstant(addDays(deadline, 1)) : null
}

export function deadlineOf(dueAt: string | null): LocalDate | null {
  return dueAt ? mskDate(instantFromMs(Date.parse(instant(dueAt)) - 1)) : null
}

/** «8-10 минут» as entered; the parsed range is stored next to it. */
function durationOf(row: OrderRow): Order['duration'] {
  return {
    raw: row.ordered_duration_raw ?? '',
    min_s: row.duration_min_s,
    max_s: row.duration_max_s,
  }
}

const VIDEO_EXT = /\.(mp4|mov|m4v|avi|mkv|webm|3gp|mts)$/i
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|tiff?|dng)$/i

/** Part of a draft not accepted yet: by its bytes when known, else by the file name. */
function draftPart(row: InboxRow): OrderPartKind | null {
  if (row.media_kind === 'video') return 'video'
  if (row.media_kind === 'image') return 'photos'
  if (row.path && VIDEO_EXT.test(row.path)) return 'video'
  if (row.path && IMAGE_EXT.test(row.path)) return 'photos'
  return null
}

function maxInstant(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null)
  return present.length === 0 ? null : present.reduce((a, b) => (a > b ? a : b))
}

function minInstant(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null)
  return present.length === 0 ? null : present.reduce((a, b) => (a < b ? a : b))
}

const ANONYMOUS: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

interface Related {
  deliveries: DeliveryRow[]
  revisions: RevisionRow[]
  messages: MessageRow[]
  inbox: InboxRow[]
  people: Map<string, ActorRef>
}

async function relatedOf(q: Queryable, model: ModelScope, rows: readonly OrderRow[]) {
  const ids = rows.map((row) => row.id)
  const empty: Related = {
    deliveries: [],
    revisions: [],
    messages: [],
    inbox: [],
    people: new Map(),
  }
  if (ids.length === 0) return empty
  const idList = sql`${sql.param(ids)}::uuid[]`
  const { rows: deliveries } = await q.execute<DeliveryRow>(sql`
    SELECT d.id, d.order_id, d.part, i.type AS item_type, i.number AS item_number,
           d.delivered_at::text AS delivered_at, d.basis, d.evidence_refs,
           d.linked_at::text AS linked_at, d.linked_by, d.confirmed_by,
           r.linked_at::text AS retracted_at, r.linked_by AS retracted_by, r.retract_reason,
           (SELECT count(DISTINCT e.asset_id)::int
              FROM asset_manifest_entries e
              JOIN assets s ON s.model_id = e.model_id AND s.id = e.asset_id
             WHERE e.model_id = d.model_id AND e.manifest_id = d.manifest_id
               AND s.media_kind = CASE d.part WHEN 'video' THEN 'video' ELSE 'image' END) AS files,
           (SELECT sum(v.duration_ms)::text
              FROM asset_manifest_entries e
              JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
              JOIN assets s ON s.model_id = e.model_id AND s.id = e.asset_id
             WHERE e.model_id = d.model_id AND e.manifest_id = d.manifest_id
               AND s.media_kind = 'video') AS duration_ms
      FROM custom_order_deliveries d
      JOIN content_items i ON i.model_id = d.model_id AND i.id = d.item_id
      LEFT JOIN custom_order_deliveries r ON r.model_id = d.model_id AND r.retracts_id = d.id
     WHERE d.model_id = ${model.id}::uuid AND d.order_id = ANY(${idList})
       AND d.retracts_id IS NULL
     ORDER BY d.linked_at, d.id`)
  const { rows: revisions } = await q.execute<RevisionRow>(sql`
    SELECT r.id, r.order_id, r.requirement, r.request_tg_ref, r.requested_at::text AS requested_at,
           r.done, r.done_basis, r.fixed_delivery_id, i.type AS fixed_item_type,
           i.number AS fixed_item_number, r.done_at::text AS done_at, r.done_by, r.created_by
      FROM custom_order_revisions r
      LEFT JOIN custom_order_deliveries d
        ON d.model_id = r.model_id AND d.order_id = r.order_id AND d.id = r.fixed_delivery_id
      LEFT JOIN content_items i ON i.model_id = d.model_id AND i.id = d.item_id
     WHERE r.model_id = ${model.id}::uuid AND r.order_id = ANY(${idList})
     ORDER BY r.requested_at, r.request_ordinal, r.id`)
  const { rows: messages } = await q.execute<MessageRow>(sql`
    SELECT order_id, tg_ref, kind, message_at::text AS message_at, author, excerpt
      FROM custom_order_messages
     WHERE model_id = ${model.id}::uuid AND order_id = ANY(${idList})
     ORDER BY message_at, id`)
  // A draft in «Приехало» that chose the order already counts as its part (SPEC §8.2).
  const { rows: inbox } = await q.execute<InboxRow>(sql`
    SELECT g.custom_order_id AS order_id, b.media_kind, d.path,
           coalesce(sr.remote_created_at, sr.detected_at, wu.completed_at, wu.created_at,
                    d.discovered_at)::text AS arrived_at
      FROM inbox_groups g
      JOIN inbox_drafts d ON d.model_id = g.model_id AND d.group_id = g.id
      LEFT JOIN source_revisions sr ON sr.model_id = d.model_id AND sr.id = d.source_revision_id
      LEFT JOIN web_uploads wu ON wu.model_id = d.model_id AND wu.id = d.web_upload_id
      LEFT JOIN blobs b ON b.sha256 = coalesce(d.master_sha256, d.source_blob_sha256)
     WHERE g.model_id = ${model.id}::uuid AND g.custom_order_id = ANY(${idList})
       AND d.state <> 'resolved'`)
  const principalIds = new Set<string>()
  const add = (id: string | null) => {
    if (id) principalIds.add(id)
  }
  for (const row of rows) {
    for (const id of [
      row.video_completed_by,
      row.photos_completed_by,
      row.closed_by,
      row.cancelled_by,
      row.created_by,
    ])
      add(id)
  }
  for (const row of deliveries)
    for (const id of [row.linked_by, row.confirmed_by, row.retracted_by]) add(id)
  for (const row of revisions) for (const id of [row.done_by, row.created_by]) add(id)
  const people = await actorRefs(q, [...principalIds])
  return { deliveries, revisions, messages, inbox, people } satisfies Related
}

/** Principals as the screen names them; agents are «агент» in the words of the screen. */
export async function actorRefs(
  q: Queryable,
  ids: readonly string[],
): Promise<Map<string, ActorRef>> {
  if (ids.length === 0) return new Map()
  const { rows } = await q.execute<PrincipalRow>(sql`
    SELECT id, kind, display_name, gender FROM principals
     WHERE id = ANY(${sql.param([...new Set(ids)])}::uuid[])`)
  return new Map(
    rows.map((row) => [
      row.id,
      {
        type: row.kind === 'human' ? ('person' as const) : ('agent' as const),
        id: row.id,
        name: row.display_name,
        gender: row.gender,
      },
    ]),
  )
}

/** What the routine and people wrote as signals: `basis.signals`, or the intake's choice. */
function matchedOf(basis: unknown): string[] {
  if (basis && typeof basis === 'object') {
    const signals = (basis as { signals?: unknown }).signals
    if (Array.isArray(signals)) return signals.filter((value) => typeof value === 'string')
    if ((basis as { chosen?: unknown }).chosen === 'intake') return ['заказ выбран в «Приехало»']
  }
  return []
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
}

interface BuildOptions {
  now: Instant
  role: Role
  modelGenitive: string
}

function buildOrder(row: OrderRow, related: Related, options: BuildOptions): Order {
  const who = (id: string | null): ActorRef =>
    id ? (related.people.get(id) ?? ANONYMOUS) : ANONYMOUS
  const whoOrNull = (id: string | null) => (id ? who(id) : null)
  const deliveryRows = related.deliveries.filter((delivery) => delivery.order_id === row.id)
  const deliveries: OrderDelivery[] = deliveryRows.map((delivery) => ({
    id: delivery.id,
    item_id: publicIdOf(delivery.item_type, delivery.item_number),
    part: delivery.part,
    matched: matchedOf(delivery.basis),
    evidence: stringsOf(delivery.evidence_refs),
    linked_by: who(delivery.linked_by),
    confirmed_by: whoOrNull(delivery.confirmed_by),
    at: instant(delivery.linked_at),
    delivered_at: instant(delivery.delivered_at),
    files: delivery.files,
    retracted:
      delivery.retracted_at === null
        ? null
        : {
            at: instant(delivery.retracted_at),
            by: who(delivery.retracted_by),
            reason: delivery.retract_reason,
          },
  }))
  const live = deliveries.filter((delivery) => delivery.retracted === null)
  const liveRows = deliveryRows.filter((delivery) => delivery.retracted_at === null)
  const pending = related.inbox.filter((draft) => draft.order_id === row.id)

  const expected: OrderPartKind[] = [
    ...(row.expects_video ? (['video'] as const) : []),
    ...(row.expects_photos ? (['photos'] as const) : []),
  ]
  const parts: OrderPart[] = expected.map((kind) => {
    const ofPart = live.filter((delivery) => delivery.part === kind)
    const last = ofPart.at(-1) ?? null
    const lastRow = liveRows.filter((delivery) => delivery.part === kind).at(-1) ?? null
    const completedAt = kind === 'video' ? row.video_completed_at : row.photos_completed_at
    const completedBy = kind === 'video' ? row.video_completed_by : row.photos_completed_by
    const latest = maxInstant(ofPart.map((delivery) => delivery.delivered_at))
    return {
      kind,
      required: kind === 'photos' ? row.photo_count : null,
      delivered: kind === 'video' ? row.live_videos : row.live_photos,
      item_id: last?.item_id ?? null,
      delivered_on: latest ? mskDate(latest) : null,
      duration_s:
        kind === 'video' && lastRow?.duration_ms
          ? Math.round(Number(lastRow.duration_ms) / 1000)
          : null,
      complete: completedAt !== null,
      completed_by: whoOrNull(completedBy),
    }
  })

  // When each part came, for overdue: the source date of the deliveries of a part marked
  // whole; a part not marked yet counts from a draft of it waiting in «Приехало».
  const partAt = (part: OrderPart): string | null => {
    if (part.complete) {
      return maxInstant(
        live.filter((delivery) => delivery.part === part.kind).map((d) => d.delivered_at),
      )
    }
    return minInstant(
      pending
        .filter((draft) => {
          const kind = draftPart(draft)
          return kind === null || kind === part.kind
        })
        .map((draft) => instant(draft.arrived_at)),
    )
  }
  const came = parts.map(partAt)
  const cameAt = came.every((at) => at !== null) ? maxInstant(came) : null
  const deadline = deadlineOf(row.due_at)
  const today = mskDate(options.now)
  const open = row.status === 'open' || row.status === 'delivered'
  const overdue = open && cameAt === null ? overdueDaysOf(deadline, today) : null
  const dueAt = row.due_at ? instant(row.due_at) : null
  const late =
    row.status !== 'cancelled' && deadline && dueAt && cameAt && cameAt > dueAt
      ? Math.max(1, daysBetween(deadline, mskDate(cameAt)))
      : null

  const revisions: OrderRevision[] = related.revisions
    .filter((revision) => revision.order_id === row.id)
    .map((revision) => {
      const basis: RevisionBasis = revision.done_basis === 'new_version' ? 'new_version' : 'checked'
      const fixed =
        revision.fixed_item_type && revision.fixed_item_number !== null
          ? publicIdOf(revision.fixed_item_type, revision.fixed_item_number)
          : null
      return {
        id: revision.id,
        text: revision.requirement,
        message_url: telegramUrlOf(revision.request_tg_ref),
        created_at: instant(revision.requested_at),
        created_by: who(revision.created_by),
        done:
          revision.done && revision.done_at
            ? {
                basis,
                by: who(revision.done_by),
                at: instant(revision.done_at),
                version_label: basis === 'new_version' && fixed ? `новая версия ${fixed}` : null,
                delivery_id: revision.fixed_delivery_id,
              }
            : null,
      }
    })

  const messageRows = related.messages.filter((message) => message.order_id === row.id)
  const ref = cardRefOf(row)
  const cardRefText = telegramRefText(ref)
  const cardMessage = messageRows.find((message) => message.kind === 'card')
  const messages: OrderMessage[] = messageRows.map((message) => ({
    at: instant(message.message_at),
    kind: message.kind,
    excerpt: message.excerpt,
    author: message.author,
    url: telegramUrlOf(message.tg_ref),
  }))

  const cancelled =
    row.cancelled_at === null
      ? null
      : { at: instant(row.cancelled_at), by: who(row.cancelled_by), reason: row.cancel_reason }
  const facts = {
    deadline,
    wants_video: row.expects_video,
    wants_photos: row.expects_photos ? (row.photo_count ?? 1) : 0,
    parts,
    revisions,
    deliveries,
    closed_at: instantOrNull(row.closed_at),
    cancelled,
    overdue_days: overdue,
    late_days: late,
    in_inbox: pending.length > 0,
  }
  const status = computeOrderStatus(facts, options.now, options.modelGenitive)
  const order: Order = {
    id: orderAddress(ref),
    title: orderTitleOf(row.brief),
    buyer: row.buyer_name,
    account: row.account_code,
    card: {
      url: telegramUrl(ref),
      ref: cardRefText,
      author: row.card_author,
      posted_at: instant(row.card_at),
      text: cardMessage?.excerpt ?? null,
    },
    brief: row.brief,
    duration: durationOf(row),
    wants_video: facts.wants_video,
    wants_photos: facts.wants_photos,
    deadline,
    fan_name: row.name_in_media,
    parts,
    deliveries,
    revisions,
    messages,
    closed_at: facts.closed_at,
    cancelled,
    overdue_days: overdue,
    late_days: late,
    in_inbox: facts.in_inbox,
    created_by: whoOrNull(row.created_by),
    version: row.row_version,
    state: status.state,
    status: { sign: status.sign, word: status.word, detail: status.detail },
    close_block: status.close_block,
  }
  return options.role === 'reader' ? redact(order) : order
}

/**
 * «Только чтение» sees neither the buyer nor the texts of orders (DESIGN §2.3, §10.11): no
 * card text or link, no revision texts or message links, no quote of a revision or a reason.
 */
function redact(order: Order): Order {
  const hideDetail = order.state === 'revision' || order.state === 'cancelled'
  return {
    ...order,
    buyer: null,
    brief: null,
    card: { ...order.card, url: '', text: null },
    revisions: order.revisions.map((revision) => ({ ...revision, text: null, message_url: null })),
    messages: [],
    deliveries: order.deliveries.map((delivery) => ({
      ...delivery,
      evidence: [],
      retracted: delivery.retracted ? { ...delivery.retracted, reason: null } : null,
    })),
    cancelled: order.cancelled ? { ...order.cancelled, reason: null } : null,
    status: hideDetail ? { ...order.status, detail: null } : order.status,
  }
}

export interface ViewContext {
  model: ModelScope & { genitive: string }
  role: Role
  now?: Instant
}

/** Orders of the model: rows chosen by `where` in the order of `tail`, as the API gives them. */
export async function orderViews(
  q: Queryable,
  context: ViewContext,
  where: SQL,
  tail: SQL = sql`ORDER BY o.card_at DESC, o.id DESC`,
): Promise<{ rows: OrderRow[]; orders: Order[] }> {
  const { rows } = await q.execute<OrderRow>(sql`
    SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM}
     WHERE o.model_id = ${context.model.id}::uuid AND (${where})
     ${tail}`)
  const related = await relatedOf(q, context.model, rows)
  const options: BuildOptions = {
    now: context.now ?? new Date().toISOString(),
    role: context.role,
    modelGenitive: context.model.genitive,
  }
  return { rows, orders: rows.map((row) => buildOrder(row, related, options)) }
}

/** `tg-…` of the path (or the stored id) → the condition on the order row. */
export function orderCondition(address: string): SQL | null {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(address)) {
    return sql`o.id = ${address}::uuid`
  }
  const ref = parseTelegramRef(address)
  if (!ref) return null
  return sql`o.tg_chat = ${ref.chat} AND o.tg_topic IS NOT DISTINCT FROM ${ref.topic}::bigint
             AND o.tg_message_id = ${ref.message}::bigint`
}

export function orderNotFound(model: ModelScope): ApiProblem {
  return new ApiProblem('not_found', `Такого заказа у модели ${model.code} нет`)
}

/** One order by its address; 404 inside the model. */
export async function orderView(q: Queryable, context: ViewContext, address: string) {
  const condition = orderCondition(address)
  if (!condition) throw orderNotFound(context.model)
  const { rows, orders } = await orderViews(q, context, condition)
  const order = orders[0]
  const row = rows[0]
  if (!order || !row) throw orderNotFound(context.model)
  return { row, order }
}

/** «Агент заказов не отмечался 2 дня»: the token of the agent that keeps the orders is silent. */
export async function agentSilence(q: Queryable, model: ModelScope, now: Instant) {
  const { rows } = await q.execute<{ last_used: string | null; agents: number }>(sql`
    SELECT max(t.last_used_at)::text AS last_used, count(DISTINCT k.actor_id)::int AS agents
      FROM (SELECT DISTINCT actor_id FROM action_log
             WHERE model_id = ${model.id}::uuid AND actor_type = 'agent'
               AND entry_kind = 'action' AND action LIKE 'orders.%') k
      LEFT JOIN api_tokens t ON t.principal_id = k.actor_id`)
  const row = rows[0]
  if (!row || row.agents === 0 || row.last_used === null) return null
  const minutes = minutesBetween(instant(row.last_used), now)
  return minutes >= 48 * 60 ? `Агент заказов не отмечался ${formatSpan(minutes)}` : null
}

/** The order of a CUS on its page (DESIGN §4.4): its first live delivery's order. */
export async function itemOrderSummary(
  q: Queryable,
  model: ModelScope,
  itemUid: string,
): Promise<{ id: string; title: string; status: Order['status']; state: Order['state'] } | null> {
  const { rows } = await q.execute<{ order_id: string | null; genitive: string }>(sql`
    SELECT c.order_id, m.title_genitive AS genitive
      FROM catalog_index c JOIN models m ON m.id = c.model_id
     WHERE c.model_id = ${model.id}::uuid AND c.item_id = ${itemUid}::uuid`)
  const row = rows[0]
  if (!row?.order_id) return null
  // The page is read by every role: the summary carries no order texts (DESIGN §10.11).
  const { orders } = await orderViews(
    q,
    { model: { ...model, genitive: row.genitive }, role: 'reader' },
    sql`o.id = ${row.order_id}::uuid`,
  )
  const order = orders[0]
  return order
    ? { id: order.id, title: order.title, status: order.status, state: order.state }
    : null
}
