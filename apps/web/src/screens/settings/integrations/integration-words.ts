import {
  formatAgo,
  INTEGRATION_NAME,
  type Instant,
  type IntegrationState,
  type IntegrationView,
} from '@contentops/contracts'
import type { IntegrationState as LineState } from '@contentops/ui/components/integration-line'

export const LINE_STATE: Record<IntegrationState, LineState> = {
  working: 'ok',
  off: 'off',
  unset: 'unset',
  down: 'down',
  catching_up: 'catching-up',
}

/**
 * Состояние интеграции в строке настроек, где имя уже стоит слева: «работает · 12 мин
 * назад», «не настроено» (§4.20). Остальные состояния — фразой §3.11 без повтора имени.
 */
export function integrationDetail(integration: IntegrationView, now: Instant): string {
  switch (integration.state) {
    case 'working':
      return integration.last_ok_at
        ? `работает · ${formatAgo(integration.last_ok_at, now)}`
        : 'работает'
    case 'unset':
      return 'не настроено'
    default: {
      const prefix = `${INTEGRATION_NAME[integration.kind]} · `
      const text = integration.line.text
      return text.startsWith(prefix) ? text.slice(prefix.length) : text
    }
  }
}
