import type { IntegrationView, Model } from '@contentops/contracts'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useClock } from '@/data/api-session'
import { useIsOwner } from '../shared/use-is-owner'
import { IntegrationStateLine } from './integration-state-line'
import { SwitchCell, SwitchHeaders } from './switch-cell'
import type { useIntegrationSwitch } from './use-integration-switch'

interface YdiskSectionProps {
  integrations: readonly IntegrationView[]
  models: readonly Model[]
  switches: ReturnType<typeof useIntegrationSwitch>
}

/** Я.Диск: скан по источнику — у каждой модели свой диск. Выключен — загрузка работает. */
export function YdiskSection({ integrations, models, switches }: YdiskSectionProps) {
  const now = useClock().now()
  const owner = useIsOwner()
  const disks = integrations.filter((integration) => integration.kind === 'ydisk')
  if (disks.length === 0) {
    return null
  }
  return (
    <SettingsSection title="Я.Диск" aside={<SwitchHeaders labels={['Скан по источнику']} />}>
      {disks.map((integration) => {
        const model = models.find((candidate) => candidate.code === integration.model)
        const name = model?.name ?? integration.model ?? 'Я.Диск'
        return (
          <SettingsRow
            key={integration.id}
            label={name}
            detail={<IntegrationStateLine integration={integration} now={now} />}
          >
            <SwitchCell
              integration={integration}
              switchKey="scan"
              label={`Скан Я.Диска · ${name}`}
              switches={switches}
              readOnly={!owner}
            />
          </SettingsRow>
        )
      })}
    </SettingsSection>
  )
}
