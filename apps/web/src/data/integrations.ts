import {
  describeIntegration,
  type Instant,
  type IntegrationLine,
  type IntegrationState,
  type IntegrationView,
  type ModelCode,
} from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'
import { useRole } from './session'

/** Интеграции с их строкой состояния; роль «только чтение» их не получает. */
export function useIntegrations() {
  const api = useApi()
  const role = useRole()
  return useQuery({
    queryKey: queryKeys.integrations(),
    queryFn: ({ signal }) => api.admin.integrations({ signal }),
    select: (page) => page.items,
    enabled: role !== null && role !== 'reader',
  })
}

/** Чем хуже состояние, тем раньше его строка. */
const SEVERITY: Record<IntegrationState, number> = {
  down: 4,
  catching_up: 3,
  off: 2,
  unset: 1,
  working: 0,
}

/**
 * Одна строка Hub для модели (DESIGN §3.11): если не работает часть страниц — фраза
 * самой тяжёлой из них со страницей; если все страницы в одном состоянии — фраза без
 * страницы. Всё работает — строки нет.
 */
export function hubLineOf(
  integrations: readonly IntegrationView[],
  model: ModelCode,
  now: Instant,
): IntegrationLine | null {
  const hub = integrations.filter(
    (integration) => integration.kind === 'hub' && integration.model === model,
  )
  const affected = hub
    .filter((integration) => integration.state !== 'working')
    .sort((left, right) => SEVERITY[right.state] - SEVERITY[left.state])
  const worst = affected[0]
  if (!worst) {
    return null
  }
  const everyPageAlike =
    affected.length === hub.length && affected.every((item) => item.state === worst.state)
  return everyPageAlike ? describeIntegration(worst, { now, accountLabel: null }) : worst.line
}
