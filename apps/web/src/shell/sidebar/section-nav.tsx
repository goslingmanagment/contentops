import { type Model, mskDate } from '@contentops/contracts'
import { NavItem } from '@contentops/ui/components/nav-item'
import { useLocation } from '@tanstack/react-router'
import { CalendarDaysIcon, FolderIcon, HistoryIcon, InboxIcon } from 'lucide-react'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useModelCounters } from '@/data/counters'
import { useRole } from '@/data/session'
import { sectionOfPath } from '../section-of-path'

interface SectionNavProps {
  model: Model
  collapsed: boolean
}

/** Счётчик пункта: у пункта либо число, либо ничего (DESIGN §2.2). */
function countOrNothing(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

/**
 * Четыре раздела одной группой без заголовков: Приехало, Библиотека, План, Журнал.
 * «Только чтение» не видит «Приехало» (DESIGN §2.3).
 */
export function SectionNav({ model, collapsed }: SectionNavProps) {
  const href = useHref()
  const role = useRole()
  const counters = useModelCounters(model.code)
  const today = mskDate(useClock().now())
  const pathname = useLocation({ select: (location) => location.pathname })
  const active = pathname.split('/')[1] === model.code ? sectionOfPath(pathname) : null
  const params = { model: model.code }

  return (
    <nav aria-label="Разделы" className="flex flex-col gap-0.5">
      {role === 'reader' ? null : (
        <NavItem
          href={href({ to: '/$model/inbox', params })}
          icon={InboxIcon}
          label="Приехало"
          count={countOrNothing(counters?.inbox)}
          active={active === 'inbox'}
          collapsed={collapsed}
        />
      )}
      <NavItem
        href={href({ to: '/$model/library', params })}
        icon={FolderIcon}
        label="Библиотека"
        active={active === 'library'}
        collapsed={collapsed}
      />
      <NavItem
        href={href({ to: '/$model/plan/$date', params: { ...params, date: today } })}
        icon={CalendarDaysIcon}
        label="План"
        count={countOrNothing(counters?.plan)}
        countTone={counters?.plan_missed ? 'danger' : 'muted'}
        active={active === 'plan'}
        collapsed={collapsed}
      />
      <NavItem
        href={href({ to: '/$model/journal', params })}
        icon={HistoryIcon}
        label="Журнал"
        active={active === 'journal'}
        collapsed={collapsed}
      />
    </nav>
  )
}
