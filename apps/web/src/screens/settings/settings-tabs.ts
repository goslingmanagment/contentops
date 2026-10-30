import type { Role } from '@contentops/contracts'
import { z } from 'zod'

/** Разделы настроек (DESIGN §2.4, §4.19): `/settings/<раздел>`. */
export const SETTINGS_TABS = [
  'models',
  'people',
  'agents',
  'integrations',
  'thresholds',
  'tags',
  'state',
  'ai',
  'profile',
] as const
export const SettingsTabSchema = z.enum(SETTINGS_TABS)
export type SettingsTab = z.infer<typeof SettingsTabSchema>

export const SETTINGS_TAB_LABEL: Record<SettingsTab, string> = {
  models: 'Модели и страницы',
  people: 'Люди и доступ',
  agents: 'Агенты и токены',
  integrations: 'Интеграции',
  thresholds: 'Пороги',
  tags: 'Теги',
  state: 'Состояние',
  ai: 'Сервис ИИ',
  profile: 'Профиль и сессии',
}

/** КМ видит в «Моделях и страницах» только «Страницы и нормы» своих моделей (§2.3). */
export function settingsTabLabel(tab: SettingsTab, role: Role): string {
  return tab === 'models' && role !== 'owner' ? 'Страницы и нормы' : SETTINGS_TAB_LABEL[tab]
}

/**
 * Кто какие разделы видит (§2.3, §4.19): интеграции КМ видит только на чтение, «Состояние»
 * видят все, действия в нём — у владельца.
 */
const VISIBLE_TABS: Record<Role, readonly SettingsTab[]> = {
  owner: SETTINGS_TABS,
  manager: ['models', 'integrations', 'state', 'profile'],
  reader: ['state', 'profile'],
}

/** Можно ли открыть раздел по адресу. «Сервис ИИ» открывается и до подключения — чтобы подключить. */
export function canOpenSettingsTab(role: Role, tab: SettingsTab): boolean {
  return VISIBLE_TABS[role].includes(tab)
}

/** Разделы в списке слева: «Сервис ИИ» появляется только после подключения (§4.19). */
export function settingsTabsFor(role: Role, aiConnected: boolean): readonly SettingsTab[] {
  return VISIBLE_TABS[role].filter((tab) => tab !== 'ai' || aiConnected)
}

/** Куда ведёт «Настройки» без раздела. */
export function defaultSettingsTab(role: Role): SettingsTab {
  return role === 'reader' ? 'profile' : 'models'
}
