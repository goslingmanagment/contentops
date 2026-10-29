import {
  type AccountCode,
  describeIntegration,
  type Instant,
  type IntegrationLine,
  type IntegrationView,
  type Model,
} from '@contentops/contracts'

/**
 * Где на «Сверить» стоит строка Hub (DESIGN §3.11): в заголовке группы своей страницы,
 * а если такой группы нет или Hub одинаково не работает на всех страницах — справа в
 * ряду чипов. Без Hub новых пар нет, а отметки работают.
 */

export interface HubLines {
  byAccount: ReadonlyMap<AccountCode, IntegrationLine>
  row: IntegrationLine | null
}

const NO_LINES: HubLines = { byAccount: new Map(), row: null }

const SEVERITY: Record<IntegrationLine['state'], number> = {
  down: 4,
  catching_up: 3,
  off: 2,
  unset: 1,
  working: 0,
}

/** «Hub выключен — подтверждения не приходят, отметки работают» (§4.15). */
function lineFor(integration: IntegrationView, accountLabel: string | null, now: Instant) {
  const line = describeIntegration(integration, { now, accountLabel })
  if (integration.state !== 'off') {
    return line
  }
  const scope = accountLabel ? ` для ${accountLabel}` : ''
  return { ...line, text: `Hub выключен${scope} — подтверждения не приходят, отметки работают` }
}

export function placeHubLines(
  integrations: readonly IntegrationView[] | undefined,
  model: Model,
  shown: ReadonlySet<AccountCode>,
  now: Instant,
): HubLines {
  const hub = (integrations ?? []).filter(
    (integration) => integration.kind === 'hub' && integration.model === model.code,
  )
  const affected = hub
    .filter((integration) => integration.state !== 'working')
    .sort((left, right) => SEVERITY[right.state] - SEVERITY[left.state])
  const worst = affected[0]
  if (!worst) {
    return NO_LINES
  }
  if (affected.length === hub.length && affected.every((item) => item.state === worst.state)) {
    return { byAccount: new Map(), row: lineFor(worst, null, now) }
  }
  const labelOf = (code: AccountCode | null) =>
    model.accounts.find((account) => account.code === code)?.label ?? null
  const byAccount = new Map<AccountCode, IntegrationLine>()
  let row: IntegrationLine | null = null
  for (const integration of affected) {
    const line = lineFor(integration, labelOf(integration.account), now)
    if (integration.account && shown.has(integration.account)) {
      byAccount.set(integration.account, line)
    } else {
      row ??= line
    }
  }
  return { byAccount, row }
}

/** «Hub обновлён 12 мин назад» для пустой очереди: самый свежий опрос страниц модели. */
export function hubUpdatedAt(
  integrations: readonly IntegrationView[] | undefined,
  model: Model,
): Instant | null {
  const times = (integrations ?? [])
    .filter((integration) => integration.kind === 'hub' && integration.model === model.code)
    .flatMap((integration) => (integration.last_ok_at ? [integration.last_ok_at] : []))
    .sort()
  return times.at(-1) ?? null
}

/**
 * Можно ли просить Hub проверить заливку на странице (DESIGN §4.15): у выключенного или
 * не настроенного Hub кнопки нет; недоступный ставит просьбу в очередь.
 */
export function hubCanCheck(
  integrations: readonly IntegrationView[] | undefined,
  model: Model,
  account: AccountCode,
): boolean {
  const hub = integrations?.find(
    (integration) =>
      integration.kind === 'hub' &&
      integration.model === model.code &&
      integration.account === account,
  )
  return hub === undefined || (hub.state !== 'off' && hub.state !== 'unset')
}
