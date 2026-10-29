import type { Instant } from './domain/common'
import type {
  Integration,
  IntegrationIcon,
  IntegrationLine,
  IntegrationState,
} from './domain/integrations'
import { INTEGRATION_NAME } from './domain/integrations'
import { formatAgo, formatClock, formatNumber, formatSpan, minutesBetween } from './format'

const ICON: Record<IntegrationState, IntegrationIcon> = {
  working: 'dot',
  off: 'power-off',
  unset: 'key-round',
  down: 'cloud-off',
  catching_up: 'refresh-cw',
}

const OWNER_ACTION: Record<IntegrationState, IntegrationLine['owner_action']> = {
  working: null,
  off: 'Включить',
  unset: 'Настроить',
  down: 'Подробнее',
  catching_up: null,
}

export interface IntegrationLineContext {
  now: Instant
  /** «Fansly 3» when the integration belongs to a page. */
  accountLabel: string | null
  /** Added after the page when the line is shown outside its model: «Fansly 2 Ари». */
  modelName?: string
}

function scopeSuffix(context: IntegrationLineContext): string {
  if (!context.accountLabel) return ''
  const model = context.modelName ? ` ${context.modelName}` : ''
  return ` для ${context.accountLabel}${model}`
}

function workingText(integration: Integration, context: IntegrationLineContext): string {
  const name = INTEGRATION_NAME[integration.kind]
  return integration.last_ok_at
    ? `${name} · ${formatAgo(integration.last_ok_at, context.now)}`
    : `${name} · работает`
}

function offText(integration: Integration, context: IntegrationLineContext): string {
  switch (integration.kind) {
    case 'ydisk':
      return 'Скан Я.Диска выключен — загрузка работает'
    case 'hub':
      return `Hub выключен${scopeSuffix(context)} — отметки работают`
    default:
      return `${INTEGRATION_NAME[integration.kind]} выключен`
  }
}

function unsetText(integration: Integration, context: IntegrationLineContext): string {
  if (integration.kind === 'hub') return `Hub${scopeSuffix(context)} не настроен`
  return `${INTEGRATION_NAME[integration.kind]} · не настроено`
}

function downText(integration: Integration, context: IntegrationLineContext): string {
  const name = INTEGRATION_NAME[integration.kind]
  if (integration.down_reason === 'format_changed') {
    return `${name} изменил формат данных — опрос остановлен до обновления`
  }
  const since = integration.since ? ` с ${formatClock(integration.since)}` : ''
  const retry =
    integration.retry_at && minutesBetween(context.now, integration.retry_at) > 0
      ? ` · повтор через ${formatSpan(minutesBetween(context.now, integration.retry_at))}`
      : ''
  return `${name} недоступен${scopeSuffix(context)}${since}${retry}`
}

function catchingUpText(integration: Integration): string {
  const progress = integration.catch_up
  const name = INTEGRATION_NAME[integration.kind]
  if (!progress) return `${name} догоняет пропущенное`
  return `${name} догоняет пропущенное · ${formatNumber(progress.done_hours)} из ${formatNumber(progress.total_hours)} ч`
}

/** The one phrase for an integration state, used in group headers, the space card and «почему». */
export function describeIntegration(
  integration: Integration,
  context: IntegrationLineContext,
): IntegrationLine {
  const texts: Record<IntegrationState, () => string> = {
    working: () => workingText(integration, context),
    off: () => offText(integration, context),
    unset: () => unsetText(integration, context),
    down: () => downText(integration, context),
    catching_up: () => catchingUpText(integration),
  }
  return {
    integration_id: integration.id,
    state: integration.state,
    icon: ICON[integration.state],
    tone: integration.state === 'down' ? 'attention' : 'muted',
    text: texts[integration.state](),
    owner_action: OWNER_ACTION[integration.state],
  }
}

/** Only «недоступно» and «догоняет» reach the space card at the bottom of the column. */
export function belongsToSpaceCard(integration: Integration): boolean {
  return integration.state === 'down' || integration.state === 'catching_up'
}
