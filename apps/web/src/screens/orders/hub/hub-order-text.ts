import {
  type Account,
  formatAgo,
  formatDate,
  formatWhen,
  type HubOrder,
  type HubOrderList,
  type HubReport,
  type Instant,
  type LocalDate,
} from '@contentops/contracts'
import { accountLabel } from '@/lib/words'

/** Группы «Заказов» (пакет N): правка и просрочка наверху, снятое — внизу, до отдачи фану. */
export type HubOrderGroup = 'revision' | 'overdue' | 'at_model' | 'partly' | 'shot'

export const HUB_GROUP_ORDER: readonly HubOrderGroup[] = [
  'revision',
  'overdue',
  'at_model',
  'partly',
  'shot',
]

export function hubGroupOf(order: HubOrder): HubOrderGroup {
  if (order.state === 'revision') return 'revision'
  if (order.overdue_days !== null) return 'overdue'
  if (order.state === 'partly') return 'partly'
  if (order.state === 'shot') return 'shot'
  return 'at_model'
}

export function hubGroupLabel(group: HubOrderGroup, modelGenitive: string): string {
  const labels: Record<HubOrderGroup, string> = {
    revision: 'Правка',
    overdue: 'Просрочено',
    at_model: `У ${modelGenitive}`,
    partly: 'Сдано частично',
    shot: 'Снято — отдать фану в Hub',
  }
  return labels[group]
}

/** «K-12 · fan_one · Fansly 1»: код, покупатель, страница — что известно. */
export function hubOrderMeta(order: HubOrder, accounts: readonly Account[]): string {
  return [
    order.code,
    order.buyer,
    order.account ? accountLabel(accounts, order.account) : order.hub_page,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** «до 14.11», «просрочено 2 дня» — срок в строке. */
export function hubDeadlineText(order: HubOrder, today: LocalDate): string {
  return order.deadline ? `до ${formatDate(order.deadline, today)}` : ''
}

/** «видео», «видео и 20 фото». */
export function hubWantsText(order: Pick<HubOrder, 'wants_video' | 'wants_photos'>): string {
  return [
    order.wants_video ? 'видео' : null,
    order.wants_photos > 0 ? `${order.wants_photos} фото` : null,
  ]
    .filter(Boolean)
    .join(' и ')
}

/** Что Hub знает о сдаче словами. */
export function reportWords(
  report: HubReport,
  now: Instant,
): { text: string; tone: 'ok' | 'wait' | 'refused' } {
  if (report.state === 'sent') {
    const at = report.at ? ` ${formatWhen(report.at, now)}` : ''
    return {
      text: report.unchanged ? `Hub уже знал это${at}` : `в Hub${at}`,
      tone: 'ok',
    }
  }
  if (report.state === 'refused') {
    return { text: report.error ?? 'Hub отказал', tone: 'refused' }
  }
  return {
    text: report.error ? `ждёт отправки в Hub · ${report.error}` : 'ждёт отправки в Hub',
    tone: 'wait',
  }
}

/** Строка чтения Hub над списком: когда читали, что не так. */
export function readLine(
  list: HubOrderList,
  now: Instant,
): { state: 'ok' | 'down' | 'unset' | 'catching-up'; text: string } {
  const unassigned =
    list.unassigned > 0 ? ` · ещё ${list.unassigned} без страницы — на доске Hub` : ''
  if (!list.configured) return { state: 'unset', text: 'Hub не настроен: заказы не читаются' }
  if (list.read_error) {
    const last = list.read_at ? `, показано чтение ${formatWhen(list.read_at, now)}` : ''
    return { state: 'down', text: `${list.read_error}${last}` }
  }
  if (!list.read_at) {
    return { state: 'catching-up', text: 'Читаю заказы Hub…' }
  }
  return {
    state: list.refreshing ? 'catching-up' : 'ok',
    text: `Hub прочитан ${formatAgo(list.read_at, now)}${unassigned}`,
  }
}
