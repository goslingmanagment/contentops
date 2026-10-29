import type { Account, IntegrationView, Model } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { SettingsRow, SettingsSection } from '@contentops/ui/components/settings-section'
import { useState } from 'react'
import { useClock } from '@/data/api-session'
import { useIsOwner } from '../shared/use-is-owner'
import { ConnectForm } from './connect-form'
import { IntegrationStateLine } from './integration-state-line'
import { SwitchCell, SwitchHeaders } from './switch-cell'
import type { useIntegrationSwitch } from './use-integration-switch'

type Switches = ReturnType<typeof useIntegrationSwitch>

interface HubSectionProps {
  integrations: readonly IntegrationView[]
  models: readonly Model[]
  switches: Switches
}

/** Agency Hub по страницам: у каждой модели своя группа, у страницы два выключателя. */
export function HubSection({ integrations, models, switches }: HubSectionProps) {
  const hub = integrations.filter((integration) => integration.kind === 'hub')
  return models.map((model) => {
    const pages = model.accounts.flatMap((account) => {
      const integration = hub.find((candidate) => candidate.account === account.code)
      return integration ? [{ account, integration }] : []
    })
    if (pages.length === 0) {
      return null
    }
    return (
      <SettingsSection
        key={model.code}
        title={`Agency Hub · ${model.name}`}
        aside={
          pages.some(({ integration }) => integration.state !== 'unset') ? (
            <SwitchHeaders labels={['Получать данные', 'Автосверка']} />
          ) : null
        }
      >
        {pages.map(({ account, integration }) => (
          <HubPageRow
            key={integration.id}
            account={account}
            model={model}
            integration={integration}
            switches={switches}
          />
        ))}
      </SettingsSection>
    )
  })
}

interface HubPageRowProps {
  account: Account
  model: Model
  integration: IntegrationView
  switches: Switches
}

function HubPageRow({ account, model, integration, switches }: HubPageRowProps) {
  const now = useClock().now()
  const owner = useIsOwner()
  const [connecting, setConnecting] = useState(false)
  const unset = integration.state === 'unset'

  return (
    <SettingsRow
      label={account.label}
      detail={<IntegrationStateLine integration={integration} now={now} />}
      below={
        connecting ? (
          <ConnectForm
            integration={integration}
            field="hub_page"
            subject={`Hub для ${account.label} ${model.name}`}
            onDone={() => setConnecting(false)}
          />
        ) : null
      }
    >
      {unset ? (
        owner && !connecting ? (
          <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>
            Настроить
          </Button>
        ) : null
      ) : (
        <>
          <SwitchCell
            integration={integration}
            switchKey="receive"
            label={`Получать данные Hub · ${account.label} · ${model.name}`}
            switches={switches}
            readOnly={!owner}
          />
          <SwitchCell
            integration={integration}
            switchKey="auto_match"
            label={`Автосверка Hub · ${account.label} · ${model.name}`}
            switches={switches}
            readOnly={!owner}
            disabled={integration.switches.receive === false}
          />
        </>
      )}
    </SettingsRow>
  )
}
