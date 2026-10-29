import type { Instant, StatusWord } from '../../../domain/common'
import type { Order, OrderList } from '../../../domain/orders'
import type { Role } from '../../../domain/people'
import type { ModelWorld, OrderRecord, World } from '../../../fixtures/world-types'
import { formatSpan, minutesBetween } from '../../../format'
import { computeOrderStatus, type OrderStatus } from '../../../order-status'

/** Orders as the «Кастомы › Заказы» view shows them. */

/** The quote of an open revision is an order text: «Только чтение» gets «◆ правка» alone. */
function statusFor(status: OrderStatus, role: Role): StatusWord {
  const hidden = role === 'reader' && status.state === 'revision'
  return { sign: status.sign, word: status.word, detail: hidden ? null : status.detail }
}

export function orderStatusOf(
  order: OrderRecord,
  now: Instant,
  modelGenitive: string,
  role: Role,
): StatusWord {
  return statusFor(computeOrderStatus(order, now, modelGenitive), role)
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
  }
}

export function orderView(
  order: OrderRecord,
  now: Instant,
  modelGenitive: string,
  role: Role,
): Order {
  const status = computeOrderStatus(order, now, modelGenitive)
  return redact(
    {
      ...order,
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
  tab: 'open' | 'closed',
): OrderList {
  const genitive = model.model.name_genitive
  const views = model.orders.map((order) => orderView(order, now, genitive, role))
  const open = views.filter((order) => order.state !== 'closed')
  const closed = views.filter((order) => order.state === 'closed')
  return {
    items: tab === 'open' ? open : closed,
    next_cursor: null,
    open_count: open.length,
    closed_count: closed.length,
    overdue_count: open.filter((order) => order.state === 'overdue').length,
    agent_silence: role === 'owner' ? agentSilence(world, model, now) : null,
  }
}
