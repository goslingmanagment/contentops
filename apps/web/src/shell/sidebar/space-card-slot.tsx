import { Skeleton } from '@contentops/ui/components/skeleton'
import { SpaceCard } from '@contentops/ui/components/space-card'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useCounters } from '@/data/counters'
import { useIntegrations } from '@/data/integrations'
import { IntegrationPhrase } from '../integration/integration-phrase'
import { useShellModel } from '../model/use-shell-model'
import { spaceAlerts } from './space-alerts'

/**
 * Карточка места внизу колонки: «C: свободно 612 ГБ» и строки, только когда что-то не
 * так. Нажатие открывает «Настройки › Состояние».
 */
export function SpaceCardSlot() {
  const counters = useCounters()
  const integrations = useIntegrations()
  const now = useClock().now()
  const model = useShellModel().model?.code ?? null
  const href = useHref()({ to: '/settings/$tab', params: { tab: 'state' } })
  const space = counters.data?.space

  if (!space && counters.isError) {
    return null
  }
  if (!space) {
    return (
      <div aria-hidden className="flex flex-col gap-2 rounded-xl bg-background p-3">
        <Skeleton className="h-4 w-32 rounded-sm" />
        <Skeleton className="h-1 w-full rounded-full" />
      </div>
    )
  }
  const alerts = spaceAlerts(space.alerts, integrations.data, now, model)
  return (
    <SpaceCard href={href} label={space.label} usedPercent={Math.round(space.used_fraction * 100)}>
      {alerts.length > 0
        ? alerts.map((line) => <IntegrationPhrase key={line.integration_id} line={line} wrap />)
        : null}
    </SpaceCard>
  )
}
