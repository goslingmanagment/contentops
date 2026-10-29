import {
  type Account,
  formatDate,
  formatDuration,
  formatNumber,
  type LocalDate,
  mskDate,
  type Order,
  type OrderPart,
  type StatusWord,
} from '@contentops/contracts'
import { accountLabel } from '@/lib/words'

/**
 * Слова заказа на экране (DESIGN §4.16, §5.5): одни и те же в строке, панели и окне.
 * Покупатель — только номером; имени фана в интерфейсе нет.
 */

/** «Кастом «вся в красном»». */
export function orderTitle(order: Pick<Order, 'title'>): string {
  return `Кастом «${order.title}»`
}

/** Дефис исходного текста — в тире диапазона: «12-15 минут» → «12–15 минут». */
function withDash(text: string): string {
  return text.replace(/(\d)\s*-\s*(\d)/gu, '$1–$2')
}

/** «8–10 мин» — разобранная длительность; `null`, если в тексте её нет. */
export function parsedDuration(duration: Order['duration']): string | null {
  const { min_s: min, max_s: max } = duration
  if (min === null || max === null) return null
  const from = Math.round(min / 60)
  const to = Math.round(max / 60)
  return from === to ? `${from} мин` : `${from}–${to} мин`
}

/** Что заказано одной фразой: «12–15 минут», «15 минут и 20 фото», «20 фото». */
export function orderedWhat(order: Pick<Order, 'duration' | 'wants_video' | 'wants_photos'>) {
  const parts: string[] = []
  if (order.wants_video && order.duration.raw) parts.push(withDash(order.duration.raw))
  else if (order.wants_video) parts.push('видео')
  if (order.wants_photos > 0) parts.push(`${formatNumber(order.wants_photos)} фото`)
  return parts.join(' и ')
}

/** Серая строка под названием: «фан №1482 · Fansly 1 · заказано 12–15 минут». */
export function orderMeta(order: Order, accounts: readonly Account[]): string {
  const what = orderedWhat(order)
  return [order.buyer, accountLabel(accounts, order.account), what ? `заказано ${what}` : null]
    .filter((part) => part !== null)
    .join(' · ')
}

export function deadlineText(order: Pick<Order, 'deadline'>, today: LocalDate): string | null {
  return order.deadline ? `до ${formatDate(order.deadline, today)}` : null
}

/**
 * Состояние для строки: у «ждём» срок уже стоит в своей колонке, у закрытого добавляется
 * дата закрытия.
 */
export function rowStatus(order: Order, today: LocalDate): StatusWord {
  if (order.state === 'waiting') return { ...order.status, detail: null }
  if (order.state === 'closed' && order.closed_at) {
    return { ...order.status, detail: formatDate(mskDate(order.closed_at), today) }
  }
  return order.status
}

/** Место миниатюры без сдачи: пунктирная рамка с заказанной длительностью. */
export function placeholderCaption(order: Order): string {
  if (!order.wants_video) return `${formatNumber(order.wants_photos)} фото`
  return parsedDuration(order.duration) ?? 'видео'
}

/** Часть сдана: видео — если есть, фото — если набралось заказанное. */
export function isPartDone(part: OrderPart): boolean {
  return part.kind === 'video' ? part.delivered > 0 : part.delivered >= (part.required ?? 0)
}

/** «15:37 · сдано 18.09» или «0 из 20». */
export function partFacts(part: OrderPart, today: LocalDate): string {
  const facts: string[] = []
  if (part.kind === 'photos') {
    facts.push(`${formatNumber(part.delivered)} из ${formatNumber(part.required ?? 0)}`)
  } else if (part.duration_s !== null) {
    facts.push(formatDuration(part.duration_s))
  }
  if (part.delivered_on && part.delivered > 0)
    facts.push(`сдано ${formatDate(part.delivered_on, today)}`)
  return facts.join(' · ')
}

/** «Видео 15:37 · сдано 18.09 · CUS-197», «Видео ещё не сдано», «Фото 0 из 20». */
function partLine(part: OrderPart, today: LocalDate): string {
  const name = part.kind === 'video' ? 'Видео' : 'Фото'
  if (part.kind === 'video' && part.delivered === 0) return 'Видео ещё не сдано'
  const facts = partFacts(part, today)
  return [facts ? `${name} ${facts}` : name, part.item_id].filter(Boolean).join(' · ')
}

/** Срок словами: «Срок до 29.09», «Срок 20.09 прошёл», «Закрыт 22.09». */
function termLine(order: Order, today: LocalDate): string {
  if (order.closed_at) return `Закрыт ${formatDate(mskDate(order.closed_at), today)}`
  if (!order.deadline) return 'Срок не указан'
  return order.state === 'overdue'
    ? `Срок ${formatDate(order.deadline, today)} прошёл`
    : `Срок до ${formatDate(order.deadline, today)}`
}

/**
 * «Почему» у слова состояния заказа (DESIGN §5.1, §5.5) — факты строками: что сдано по
 * частям, срок и открытая правка, если она есть.
 */
export function orderWhyFacts(order: Order, today: LocalDate): string[] {
  const parts =
    order.parts.length > 0 ? order.parts.map((part) => partLine(part, today)) : ['Сдачи пока нет']
  const revision = order.revisions.find((entry) => entry.done === null)
  const revisionLine = revision
    ? `Правка ${formatDate(mskDate(revision.created_at), today)} · ${revision.created_by.name}`
    : null
  return [...parts, termLine(order, today), ...(revisionLine ? [revisionLine] : [])]
}
