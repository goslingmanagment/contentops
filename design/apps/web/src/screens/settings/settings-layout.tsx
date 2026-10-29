import type { Role } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { cn } from '@contentops/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import {
  ActivityIcon,
  BotIcon,
  LayoutListIcon,
  type LucideIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TagsIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react'
import { createContext, type ReactNode, useContext } from 'react'
import { FieldLayout } from '@/shell/field/field-layout'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { type SettingsTab, settingsTabLabel } from './settings-tabs'

const TAB_ICON: Record<SettingsTab, LucideIcon> = {
  models: LayoutListIcon,
  people: UsersIcon,
  agents: BotIcon,
  integrations: PlugIcon,
  thresholds: SlidersHorizontalIcon,
  tags: TagsIcon,
  state: ActivityIcon,
  ai: SparklesIcon,
  profile: UserRoundIcon,
}

export interface SettingsNav {
  /** Раздел, который открыт; `null` — страница вне списка (норма страницы). */
  current: SettingsTab | null
  tabs: readonly SettingsTab[]
  role: Role
}

const SettingsNavContext = createContext<SettingsNav | null>(null)
export const SettingsNavProvider = SettingsNavContext.Provider

interface SettingsFrameProps extends SettingsNav {
  /** Заголовок раздела: «Люди и доступ». */
  title: string
  /** Справа в шапке: главная кнопка раздела («Добавить человека», «Выдать токен»). */
  actions?: ReactNode
  /** Фоновое обновление: полоска 2 px, ввод не сбрасывается (§3.10). */
  refreshing?: boolean
  children: ReactNode
}

/**
 * Настройки (DESIGN §4.19): шапка поля с разделом и главной кнопкой, ниже слева список
 * разделов 220, справа форма. «Страницы и нормы» модели встают в ту же рамку.
 */
export function SettingsFrame({
  current,
  tabs,
  role,
  title,
  actions,
  refreshing = false,
  children,
}: SettingsFrameProps) {
  return (
    <FieldLayout>
      <FieldHeader crumbs={[{ label: 'Настройки' }]} title={title} actions={actions} />
      <RefreshStrip active={refreshing} />
      <div className="flex min-h-0 flex-1 gap-8 pt-3">
        <SettingsNavList current={current} tabs={tabs} role={role} />
        <div className="-mx-2 min-h-0 min-w-0 flex-1 overflow-y-auto px-2 pb-10">
          <div className="flex max-w-220 flex-col gap-9">{children}</div>
        </div>
      </div>
    </FieldLayout>
  )
}

function SettingsNavList({ current, tabs, role }: SettingsNav) {
  return (
    <nav aria-label="Разделы настроек" className="w-55 shrink-0">
      <ul className="flex flex-col gap-0.5">
        {tabs.map((tab) => {
          const Icon = TAB_ICON[tab]
          const active = tab === current
          return (
            <li key={tab}>
              <Link
                to="/settings/$tab"
                params={{ tab }}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-lg px-3 text-base transition-colors duration-120 hover:bg-accent',
                  active && 'bg-primary-tint font-medium text-primary-ink hover:bg-primary-tint',
                )}
              >
                <Icon
                  aria-hidden
                  className={cn('size-4.5 shrink-0', active ? 'text-primary' : 'text-ink-3')}
                />
                <span className="truncate">{settingsTabLabel(tab, role)}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

type SettingsPageProps = Omit<SettingsFrameProps, keyof SettingsNav>

/** Раздел настроек внутри экрана «Настройки»: список разделов берётся из экрана. */
export function SettingsPage(props: SettingsPageProps) {
  const nav = useContext(SettingsNavContext)
  if (!nav) {
    throw new Error('SettingsPage вне экрана настроек: нет SettingsNavProvider')
  }
  return <SettingsFrame {...nav} {...props} />
}
