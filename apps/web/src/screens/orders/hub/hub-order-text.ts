import {
  type Account,
  formatAgo,
  formatDate,
  formatWhen,
  type HubOrder,
  type HubOrderList,
  type HubReport,
  type Instant,
  isKnownHubState,
  type LocalDate,
} from '@contentops/contracts'
import { accountLabel } from '@/lib/words'

/**
 * Группы «Съёмки › Кастомы» (пакет C3): передать модели (проверен в Hub или модель отказалась),
 * у модели (и сдано частично), правка, просрочено, снято — до отдачи фану; шаг, которого эта
 * версия не знает (Hub добавил его позже), — отдельной группой в конце.
 */
export type HubOrderGroup = 'handover' | 'at_model' | 'revision' | 'overdue' | 'shot' | 'other'

export const HUB_GROUP_ORDER: readonly HubOrderGroup[] = [
  'handover',
  'at_model',
  'revision',
  'overdue',
  'shot',
  'other',
]

export function hubGroupOf(order: HubOrder): HubOrderGroup {
  if (!isKnownHubState(order.state)) return 'other'
  if (order.state === 'revision') return 'revision'
  if (order.overdue_days !== null) return 'overdue'
  if (order.state === 'checked' || order.state === 'refused') return 'handover'
  if (order.state === 'shot') return 'shot'
  return 'at_model'
}

export function hubGroupLabel(group: HubOrderGroup, modelGenitive: string): string {
  const labels: Record<HubOrderGroup, string> = {
    handover: 'Передать модели',
    at_model: `У ${modelGenitive}`,
    revision: 'Правка',
    overdue: 'Просрочено',
    shot: 'Снято: отдать фану',
    other: 'Другие шаги',
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
      text: report.unchanged ? `уже было записано${at}` : `записано${at}`,
      tone: 'ok',
    }
  }
  if (report.state === 'refused') {
    return { text: report.error ?? 'не записано', tone: 'refused' }
  }
  return {
    text: report.error ? `ждёт записи · ${report.error}` : 'ждёт записи',
    tone: 'wait',
  }
}

/** Строка чтения Hub над списком: когда читали, что не так. */
export function readLine(
  list: HubOrderList,
  now: Instant,
): { state: 'ok' | 'down' | 'unset' | 'catching-up'; text: string } {
  const unassigned =
    list.unassigned > 0 ? ` · ещё ${list.unassigned} без страницы: они в Workboard` : ''
  if (!list.configured) return { state: 'unset', text: 'Заказы не подключены' }
  if (list.read_error) {
    const last = list.read_at ? `, показано чтение ${formatWhen(list.read_at, now)}` : ''
    return { state: 'down', text: `${list.read_error}${last}` }
  }
  if (!list.read_at) {
    return { state: 'catching-up', text: 'Обновляю заказы…' }
  }
  return {
    state: list.refreshing ? 'catching-up' : 'ok',
    text: `Обновлено ${formatAgo(list.read_at, now)}${unassigned}`,
  }
}
