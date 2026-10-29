import type { Instant, IntegrationView } from '@contentops/contracts'
import { IntegrationLine } from '@contentops/ui/components/integration-line'
import { integrationDetail, LINE_STATE } from './integration-words'

/** Вторая строка интеграции: значок состояния и слова (§3.11). */
export function IntegrationStateLine({
  integration,
  now,
  text,
}: {
  integration: IntegrationView
  now: Instant
  /** Своя фраза вместо общей: Telegram пишет, когда агент заказов писал. */
  text?: string
}) {
  const words = text ?? integrationDetail(integration, now)
  return (
    <IntegrationLine state={LINE_STATE[integration.state]} title={words} className="max-w-full">
      {words}
    </IntegrationLine>
  )
}
