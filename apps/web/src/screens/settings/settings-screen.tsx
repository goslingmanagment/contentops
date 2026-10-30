import { FieldHeader } from '@contentops/ui/components/field-header'
import { getRouteApi } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { useIntegrations } from '@/data/integrations'
import { useRole } from '@/data/session'
import { FieldLayout } from '@/shell/field/field-layout'
import { ForbiddenState } from '../errors'
import { AgentsSection } from './agents/agents-section'
import { AiSection } from './ai/ai-section'
import { IntegrationsSection } from './integrations/integrations-section'
import { ModelsSection } from './models/models-section'
import { PeopleSection } from './people/people-section'
import { ProfileSection } from './profile/profile-section'
import { SettingsNavProvider } from './settings-layout'
import { canOpenSettingsTab, type SettingsTab, settingsTabsFor } from './settings-tabs'
import { StateSection } from './state/state-section'
import { TagsSection } from './tags/tags-section'
import { ThresholdsSection } from './thresholds/thresholds-section'

const routeApi = getRouteApi('/_shell/settings/$tab')

/** Разделы по адресу `/settings/<раздел>`: каждый живёт в своей папке. */
const SECTIONS: Record<SettingsTab, ComponentType> = {
  models: ModelsSection,
  people: PeopleSection,
  agents: AgentsSection,
  integrations: IntegrationsSection,
  thresholds: ThresholdsSection,
  tags: TagsSection,
  state: StateSection,
  ai: AiSection,
  profile: ProfileSection,
}

/** «Сервис ИИ» в списке слева — только после подключения (§4.19). */
function useAiConnected(): boolean {
  const integrations = useIntegrations()
  return (
    integrations.data?.some(
      (integration) => integration.kind === 'ai' && integration.state !== 'unset',
    ) ?? false
  )
}

/**
 * Настройки `/settings/<раздел>` (DESIGN §4.19): что видят владелец, КМ и «только
 * чтение» (§2.3). Раздел без прав — «Нет доступа к этому разделу» на месте поля.
 */
export function SettingsScreen() {
  const { tab } = routeApi.useParams()
  const role = useRole()
  const aiConnected = useAiConnected()

  if (!role) {
    return (
      <FieldLayout>
        <FieldHeader crumbs={[{ label: 'Настройки' }]} title="" />
      </FieldLayout>
    )
  }
  if (!canOpenSettingsTab(role, tab)) {
    return <ForbiddenState message="Нет доступа к этому разделу" />
  }
  const Section = SECTIONS[tab]
  const tabs = settingsTabsFor(role, aiConnected)
  // «Сервис ИИ» до подключения открыт из «Интеграций»: в списке горит она.
  const current = tabs.includes(tab) ? tab : 'integrations'
  return (
    <SettingsNavProvider value={{ current, tabs, role }}>
      <Section />
    </SettingsNavProvider>
  )
}
