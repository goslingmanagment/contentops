import { mskDate } from '@contentops/contracts/clock'
import type { Instant, StatusWord } from '@contentops/contracts/domain/common'
import type {
  Order,
  OrderDelivery,
  OrderList,
  OrderMessage,
  OrderPart,
  OrderRevision,
  OrderTab,
} from '@contentops/contracts/domain/orders'
import type { Role } from '@contentops/contracts/domain/people'
import { formatSpan, minutesBetween } from '@contentops/contracts/format'
import { parseTelegramRef, telegramRefText } from '@contentops/contracts/order-link'
import {
  computeOrderStatus,
  type OrderStatus,
  type OrderStatusFacts,
  orderComplete,
  overdueDaysOf,
} from '@contentops/contracts/order-status'
import type { ModelWorld, OrderRecord, World } from '../fixtures/world-types'

/** Orders as the «Кастомы › Заказы» view shows them. */

/** The quote of an open revision is an order text: «Только чтение» gets «◆ правка» alone. */
function statusFor(status: OrderStatus, role: Role): StatusWord {
  const hidden = role === 'reader' && (status.state === 'revision' || status.state === 'cancelled')
  return { sign: status.sign, word: status.word, detail: hidden ? null : status.detail }
}

/** A part of the fixtures: whole when the clip came, photos — when the number came. */
function partOf(part: OrderRecord['parts'][number]): OrderPart {
  const complete =
    part.complete ??
    (part.kind === 'video' ? part.delivered > 0 : part.delivered >= (part.required ?? 1))
  return { ...part, complete, completed_by: part.completed_by ?? null }
}

function deliveryOf(
  order: OrderRecord,
  delivery: OrderRecord['deliveries'][number],
): OrderDelivery {
  const part =
    delivery.part ??
    order.parts.find((candidate) => candidate.item_id === delivery.item_id)?.kind ??
    'video'
  return {
    ...delivery,
    part,
    evidence: delivery.evidence ?? [],
    delivered_at: delivery.delivered_at ?? delivery.at,
    files: delivery.files ?? 1,
    retracted: delivery.retracted ?? null,
  }
}

function revisionOf(revision: OrderRecord['revisions'][number]): OrderRevision {
  return {
    ...revision,
    done: revision.done
      ? { ...revision.done, delivery_id: revision.done.delivery_id ?? null }
      : null,
  }
}

function messageOf(message: OrderRecord['messages'][number]): OrderMessage {
  return { author: '', url: null, ...message }
}

/** The fixtures' order with the server's computed fields: what the status is computed from. */
export function orderFacts(
  order: OrderRecord,
  now: Instant,
): OrderStatusFacts & {
  parts: OrderPart[]
  deliveries: OrderDelivery[]
  revisions: OrderRevision[]
} {
  const parts = order.parts.map(partOf)
  const complete = orderComplete({ parts })
  const closed = order.closed_at !== null || Boolean(order.cancelled)
  return {
    deadline: order.deadline,
    wants_video: order.wants_video,
    wants_photos: order.wants_photos,
    parts,
    revisions: order.revisions.map(revisionOf),
    deliveries: order.deliveries.map((delivery) => deliveryOf(order, delivery)),
    closed_at: order.closed_at,
    cancelled: order.cancelled ? { reason: order.cancelled.reason } : null,
    overdue_days: complete || closed ? null : overdueDaysOf(order.deadline, mskDate(now)),
    late_days: null,
    in_inbox: false,
  }
}

export function orderStatusOf(
  order: OrderRecord,
  now: Instant,
  modelGenitive: string,
  role: Role,
): StatusWord {
  return statusFor(computeOrderStatus(orderFacts(order, now), now, modelGenitive), role)
}

/**
 * «Только чтение» sees neither the buyer nor the texts of orders (DESIGN §2.3, §10.11): no
 * card text or link, no revision texts or message links, «◆ правка» without the quote.
 */
function redact(order: Order, role: Role): Order {
  if (role !== 'reader') return order
  return {
    ...order,
    buyer: null,
    brief: null,
    card: { ...order.card, url: '', text: null },
    revisions: order.revisions.map((revision) => ({
      ...revision,
      text: null,
      message_url: null,
    })),
    messages: [],
    cancelled: order.cancelled ? { ...order.cancelled, reason: null } : null,
  }
}

export function orderView(
  order: OrderRecord,
  now: Instant,
  modelGenitive: string,
  role: Role,
  actor?: Order['created_by'],
): Order {
  const facts = orderFacts(order, now)
  const status = computeOrderStatus(facts, now, modelGenitive)
  const ref = parseTelegramRef(order.card.url)
  const by = actor ?? { type: 'agent' as const, id: null, name: 'Агент заказов', gender: null }
  return redact(
    {
      id: order.id,
      title: order.title,
      buyer: order.buyer,
      account: order.account,
      card: { ...order.card, ref: ref ? telegramRefText(ref) : order.id },
      brief: order.brief,
      duration: order.duration,
      wants_video: order.wants_video,
      wants_photos: order.wants_photos,
      deadline: order.deadline,
      fan_name: order.fan_name,
      parts: facts.parts,
      deliveries: facts.deliveries,
      revisions: facts.revisions,
      messages: order.messages.map(messageOf),
      closed_at: order.closed_at,
      cancelled: order.cancelled ? { ...order.cancelled, by } : null,
      overdue_days: facts.overdue_days,
      late_days: null,
      in_inbox: false,
      created_by: by,
      version: order.version,
      state: status.state,
      status: statusFor(status, role),
      close_block: status.close_block,
    },
    role,
  )
}

/** «Агент заказов не отмечался 2 дня» — only when the Telegram routine is silent. */
function agentSilence(world: World, model: ModelWorld, now: Instant): string | null {
  const telegram = world.integrations.find(
    (integration) => integration.kind === 'telegram' && integration.model === model.model.code,
  )
  if (!telegram?.last_ok_at) return null
  const minutes = minutesBetween(telegram.last_ok_at, now)
  return minutes >= 24 * 60 ? `Агент заказов не отмечался ${formatSpan(minutes)}` : null
}

export function orderList(
  world: World,
  model: ModelWorld,
  now: Instant,
  role: Role,
  tab: OrderTab,
  q?: string,
): OrderList {
  const genitive = model.model.name_genitive
  const views = model.orders.map((order) => orderView(order, now, genitive, role))
  const open = views.filter((order) => order.state !== 'closed' && order.state !== 'cancelled')
  const closed = views.filter((order) => order.state === 'closed')
  const cancelled = views.filter((order) => order.state === 'cancelled')
  const needle = q?.trim().toLowerCase()
  const found = needle
    ? views.filter((order) =>
        [order.buyer, order.title, order.brief].some((text) =>
          text?.toLowerCase().includes(needle),
        ),
      )
    : null
  return {
    items: found ?? (tab === 'open' ? open : tab === 'closed' ? closed : cancelled),
    next_cursor: null,
    open_count: open.length,
    closed_count: closed.length,
    cancelled_count: cancelled.length,
    overdue_count: open.filter((order) => order.state === 'overdue').length,
    agent_silence: role === 'reader' ? null : agentSilence(world, model, now),
  }
}
