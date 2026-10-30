import { daysBetween, mskDate } from './clock'
import type { Instant, LocalDate, StatusWord } from './domain/common'
import type { OrderDelivery, OrderPart, OrderRevision, OrderState } from './domain/orders'
import { formatDate, formatNumber, plural } from './format'

/** What the order status is computed from; the server owns it (DESIGN §10.7). */
export interface OrderStatusFacts {
  deadline: LocalDate | null
  wants_video: boolean
  wants_photos: number
  parts: readonly OrderPart[]
  revisions: readonly Pick<OrderRevision, 'done' | 'text'>[]
  deliveries: readonly Pick<OrderDelivery, 'retracted'>[]
  closed_at: Instant | null
  cancelled: { reason: string | null } | null
  /** Computed by the server from the delivery dates in the source (SPEC §8.2). */
  overdue_days: number | null
  late_days: number | null
  in_inbox: boolean
}

export interface OrderStatus extends StatusWord {
  state: OrderState
  close_block: string | null
}

/** Every ordered part is marked delivered whole. */
export function orderComplete(facts: Pick<OrderStatusFacts, 'parts'>): boolean {
  return facts.parts.length > 0 && facts.parts.every((part) => part.complete)
}

function missingText(facts: OrderStatusFacts): string {
  return facts.parts
    .map((part) => {
      if (part.kind === 'video') {
        if (part.complete) return 'видео есть'
        return part.delivered > 0 ? 'видео не всё' : 'видео нет'
      }
      const required = part.required === null ? '' : ` из ${formatNumber(part.required)}`
      if (part.complete) return `фото ${formatNumber(part.delivered)}${required}`
      return `фото ${formatNumber(part.delivered)}${required}`
    })
    .join(', ')
}

function lastDelivery(facts: OrderStatusFacts): LocalDate | null {
  const dates = facts.parts.map((part) => part.delivered_on).filter((date) => date !== null)
  return dates.sort().at(-1) ?? null
}

const DAYS: readonly [string, string, string] = ['день', 'дня', 'дней']

/** Days past the deadline while not delivered, by the day in Moscow; `null` — not overdue. */
export function overdueDaysOf(deadline: LocalDate | null, today: LocalDate): number | null {
  if (!deadline || deadline >= today) return null
  return daysBetween(deadline, today)
}

export function computeOrderStatus(
  facts: OrderStatusFacts,
  now: Instant,
  modelGenitive: string,
): OrderStatus {
  if (facts.cancelled) {
    return {
      state: 'cancelled',
      sign: null,
      word: 'снят',
      detail: facts.cancelled.reason,
      close_block: 'Заказ снят',
    }
  }
  if (facts.closed_at) {
    return {
      state: 'closed',
      sign: null,
      word: 'закрыт',
      detail: null,
      close_block: 'Заказ закрыт',
    }
  }
  const today = mskDate(now)
  const openRevision = facts.revisions.find((revision) => revision.done === null)
  const complete = orderComplete(facts)
  const delivered = facts.deliveries.some((delivery) => delivery.retracted === null)
  const closeBlock = openRevision
    ? 'Сначала отметьте правку выполненной'
    : complete
      ? null
      : `Ещё не всё сдано: ${missingText(facts)}`
  // «Сдано, требуется правка» (SPEC §5): there is a delivery and a revision is open.
  if (openRevision && delivered) {
    return {
      state: 'revision',
      sign: 'turn',
      word: 'правка',
      detail: openRevision.text ? `«${openRevision.text}»` : null,
      close_block: closeBlock,
    }
  }
  if (facts.overdue_days !== null) {
    return {
      state: 'overdue',
      sign: 'trouble',
      word: 'просрочено',
      detail: `${facts.overdue_days} ${plural(facts.overdue_days, DAYS)}`,
      close_block: closeBlock,
    }
  }
  if (complete) {
    const on = lastDelivery(facts)
    const late =
      facts.late_days === null
        ? null
        : `на ${facts.late_days} ${plural(facts.late_days, DAYS)} позже срока`
    return {
      state: 'delivered',
      sign: 'done',
      word: 'сдано',
      detail: [on ? formatDate(on, today) : null, late].filter(Boolean).join(' · ') || null,
      close_block: closeBlock,
    }
  }
  if (delivered) {
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
    detail: facts.in_inbox
      ? 'сдача в «Приехало»'
      : facts.deadline
        ? `до ${formatDate(facts.deadline, today)}`
        : null,
    close_block: closeBlock,
  }
}
