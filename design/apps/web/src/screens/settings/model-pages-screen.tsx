import { FieldHeader } from '@contentops/ui/components/field-header'
import { getRouteApi } from '@tanstack/react-router'
import { useIntegrations } from '@/data/integrations'
import { useRole } from '@/data/session'
import { NormsView } from '@/screens/plan/norms'
import { FieldLayout } from '@/shell/field/field-layout'
import { ForbiddenState } from '../errors'
import { SettingsFrame } from './settings-layout'
import { canOpenSettingsTab, settingsTabsFor } from './settings-tabs'

const routeApi = getRouteApi('/_shell/$model/settings/pages/$account')

const TITLE = 'Страницы и нормы'

/** «Сервис ИИ» в списке разделов — только после подключения (§4.19). */
function useAiConnected(): boolean {
  const integrations = useIntegrations()
  return (
    integrations.data?.some(
      (integration) => integration.kind === 'ai' && integration.state !== 'unset',
    ) ?? false
  )
}

/**
 * Страницы и нормы модели `#/<модель>/settings/pages/<страница>` (DESIGN §4.14, §4.19):
 * одно имя, рамка Настроек, в списке разделов горит «Страницы и нормы» («Модели и
 * страницы» у владельца). Из Плана сюда ведёт «Нормы». У каждой страницы своя правка:
 * переход на другую страницу начинает с её нормы.
 */
export function ModelPagesScreen() {
  const { account } = routeApi.useParams()
  const role = useRole()
  const aiConnected = useAiConnected()
  if (!role) {
    return (
      <FieldLayout>
        <FieldHeader crumbs={[{ label: 'Настройки' }]} title={TITLE} />
      </FieldLayout>
    )
  }
  if (!canOpenSettingsTab(role, 'models')) {
    return <ForbiddenState message="Нет доступа к этому разделу" />
  }
  return (
    <SettingsFrame
      current="models"
      tabs={settingsTabsFor(role, aiConnected)}
      role={role}
      title={TITLE}
    >
      <NormsView key={account} account={account} />
    </SettingsFrame>
  )
}
