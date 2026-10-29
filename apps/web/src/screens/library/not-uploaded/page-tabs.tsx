import type { AccountCode } from '@contentops/contracts'
import { SectionTabs } from '@contentops/ui/components/section-tabs'
import type { BacklogTab } from './use-backlog-data'

interface PageTabsProps {
  tabs: readonly BacklogTab[]
  value: AccountCode
  onChange: (account: AccountCode) => void
}

/**
 * Вкладки страниц «Fansly 1 · Fansly 2 · … · OF Free» (DESIGN §4.3): у каждой серое
 * число без фупов; пока индекс не пришёл, на месте числа заготовка той же ширины.
 */
export function PageTabs({ tabs, value, onChange }: PageTabsProps) {
  return (
    <SectionTabs
      label="Страницы"
      value={value}
      onChange={onChange}
      tabs={tabs.map((tab) => ({
        value: tab.account.code,
        label: tab.account.label,
        detail: tab.count,
      }))}
    />
  )
}
