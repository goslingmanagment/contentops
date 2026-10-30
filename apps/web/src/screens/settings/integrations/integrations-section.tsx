import { SettingsSectionSkeleton } from '@contentops/ui/components/settings-section'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useIntegrations } from '@/data/integrations'
import { useModels } from '@/data/session'
import { SettingsPage } from '../settings-layout'
import { HubSection } from './hub-section'
import { ServicesSection } from './services-section'
import { useIntegrationSwitch } from './use-integration-switch'
import { YdiskSection } from './ydisk-section'

/**
 * «Интеграции» (DESIGN §4.19): Я.Диск — скан по источнику; Hub — «Получать данные» и
 * «Автосверка» по каждой странице; ИИ, агенты, Fyper; Telegram — только состояние.
 * Меняет владелец, КМ видит то же без управления.
 */
export function IntegrationsSection() {
  const integrations = useIntegrations()
  const models = useModels()
  const switches = useIntegrationSwitch()
  const items = integrations.data

  return (
    <SettingsPage
      title="Интеграции"
      refreshing={integrations.isFetching && !integrations.isPending}
    >
      {integrations.isError && !items ? (
        <ErrorLine
          layout="center"
          message="Не загрузилось"
          onRetry={() => void integrations.refetch()}
        />
      ) : null}
      {integrations.isPending ? (
        <>
          <SettingsSectionSkeleton rows={3} />
          <SettingsSectionSkeleton rows={6} />
        </>
      ) : null}
      {items && models.data ? (
        <>
          <YdiskSection
            kind="dropbox"
            integrations={items}
            models={models.data}
            switches={switches}
          />
          <YdiskSection
            kind="ydisk"
            integrations={items}
            models={models.data}
            switches={switches}
          />
          <HubSection integrations={items} models={models.data} switches={switches} />
          <ServicesSection integrations={items} switches={switches} />
        </>
      ) : null}
    </SettingsPage>
  )
}
