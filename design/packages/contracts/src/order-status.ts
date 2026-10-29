import { daysBetween, mskDate } from './clock'
import type { Instant, StatusWord } from './domain/common'
import type { OrderPart, OrderRevision, OrderState } from './domain/orders'
import { formatDate, plural } from './format'

/** What the order status is computed from; the server owns it (DESIGN §10.7). */
export interface OrderStatusFacts {
  deadline: string | null
  wants_video: boolean
  wants_photos: number
  parts: readonly OrderPart[]
  revisions: readonly OrderRevision[]
  closed_at: Instant | null
}

export interface OrderStatus extends StatusWord {
  state: OrderState
  close_block: string | null
}

function videoDone(facts: OrderStatusFacts): boolean {
  if (!facts.wants_video) return true
  return facts.parts.some((part) => part.kind === 'video' && part.delivered > 0)
}

function photosDelivered(facts: OrderStatusFacts): number {
  return facts.parts
    .filter((part) => part.kind === 'photos')
    .reduce((sum, part) => sum + part.delivered, 0)
}

function missingText(facts: OrderStatusFacts): string {
  const parts: string[] = []
  if (facts.wants_video) parts.push(videoDone(facts) ? 'видео есть' : 'видео нет')
  if (facts.wants_photos > 0) parts.push(`фото ${photosDelivered(facts)} из ${facts.wants_photos}`)
  return parts.join(', ')
}

function lastDelivery(facts: OrderStatusFacts): string | null {
  const dates = facts.parts.map((part) => part.delivered_on).filter((date) => date !== null)
  return dates.sort().at(-1) ?? null
}

export function computeOrderStatus(
  facts: OrderStatusFacts,
  now: Instant,
  modelGenitive: string,
): OrderStatus {
  if (facts.closed_at) {
    return {
      state: 'closed',
      sign: null,
      word: 'закрыт',
      detail: null,
      close_block: 'Заказ закрыт',
    }
  }
  const openRevision = facts.revisions.find((revision) => revision.done === null)
  const complete = videoDone(facts) && photosDelivered(facts) >= facts.wants_photos
  const anyDelivered = facts.parts.some((part) => part.delivered > 0)
  const closeBlock = openRevision
    ? 'Сначала отметьте правку выполненной'
    : complete
      ? null
      : `Ещё не всё сдано: ${missingText(facts)}`
  if (openRevision) {
    return {
      state: 'revision',
      sign: 'turn',
      word: 'правка',
      detail: openRevision.text ? `«${openRevision.text}»` : null,
      close_block: closeBlock,
    }
  }
  const today = mskDate(now)
  if (!complete && facts.deadline && facts.deadline < today) {
    const days = daysBetween(facts.deadline, today)
    return {
      state: 'overdue',
      sign: 'trouble',
      word: 'просрочено',
      detail: `${days} ${plural(days, ['день', 'дня', 'дней'])}`,
      close_block: closeBlock,
    }
  }
  if (complete) {
    const on = lastDelivery(facts)
    return {
      state: 'delivered',
      sign: 'done',
      word: 'сдано',
      detail: on ? formatDate(on, today) : null,
      close_block: null,
    }
  }
  if (anyDelivered) {
    return {
      state: 'partial',
      sign: null,
      word: 'сдано частично',
      detail: missingText(facts),
      close_block: closeBlock,
    }
  }
  return {
    state: 'waiting',
    sign: null,
    word: `ждём от ${modelGenitive}`,
    detail: facts.deadline ? `до ${formatDate(facts.deadline, today)}` : null,
    close_block: closeBlock,
  }
}
