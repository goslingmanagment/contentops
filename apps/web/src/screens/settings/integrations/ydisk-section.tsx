import type { IntegrationView, Model } from '@contentops/contracts'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useClock } from '@/data/api-session'
import { useIsOwner } from '../shared/use-is-owner'
import { IntegrationStateLine } from './integration-state-line'
import { SwitchCell, SwitchHeaders } from './switch-cell'
import type { useIntegrationSwitch } from './use-integration-switch'

interface YdiskSectionProps {
  /** Облако модели: Dropbox (новое Лоры с 15.10.2026) или Я.Диск (SPEC §6.1). */
  kind: 'ydisk' | 'dropbox'
  integrations: readonly IntegrationView[]
  models: readonly Model[]
  switches: ReturnType<typeof useIntegrationSwitch>
}

const TITLE = { ydisk: 'Я.Диск', dropbox: 'Dropbox' } as const
const SCAN_OF = { ydisk: 'Скан Я.Диска', dropbox: 'Скан Dropbox' } as const

/** Облако модели: скан по источнику — у каждой модели своё. Выключен — загрузка работает. */
export function YdiskSection({ kind, integrations, models, switches }: YdiskSectionProps) {
  const now = useClock().now()
  const owner = useIsOwner()
  const disks = integrations.filter((integration) => integration.kind === kind)
  if (disks.length === 0) {
    return null
  }
  return (
    <SettingsSection title={TITLE[kind]} aside={<SwitchHeaders labels={['Скан по источнику']} />}>
      {disks.map((integration) => {
        const model = models.find((candidate) => candidate.code === integration.model)
        const name = model?.name ?? integration.model ?? TITLE[kind]
        return (
          <SettingsRow
            key={integration.id}
            label={name}
            detail={<IntegrationStateLine integration={integration} now={now} />}
          >
            <SwitchCell
              integration={integration}
              switchKey="scan"
              label={`${SCAN_OF[kind]} · ${name}`}
              switches={switches}
              readOnly={!owner}
            />
          </SettingsRow>
        )
      })}
    </SettingsSection>
  )
}
