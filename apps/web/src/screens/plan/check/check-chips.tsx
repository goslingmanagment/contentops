import { type Account, formatNumber, type IntegrationLine } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  FilterChipsRow,
  type FilterOption,
  FilterSelectChip,
} from '@contentops/ui/components/filter-chips'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { ChevronLeftIcon } from 'lucide-react'
import type { ClosedView } from '@/data/check'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import type { CaseFilter } from './case-groups'

const CLOSED_TITLE: Record<ClosedView, string> = {
  done: 'Решённые за 14 дней',
  'not-ours': 'Не наше',
}

interface CheckChipsProps {
  /** `null` — очередь случаев; иначе «Решённые» или «Не наше». */
  closed: ClosedView | null
  accounts: readonly Account[]
  weeks: readonly FilterOption[]
  filter: CaseFilter
  onFilterChange: (next: CaseFilter) => void
  /** Строка Hub, у которой нет своей группы (§3.11): справа в ряду чипов. */
  hubLine: IntegrationLine | null
  counts: { done: number; notOurs: number } | null
  onShow: (view: ClosedView | null) => void
}

/**
 * Ряд под шапкой (DESIGN §4.15): «Страница ▾», «Неделя ▾», «Сбросить»; справа строка Hub
 * и «⋯»: «Решённые за 14 дней», «Не наше». Ряд стоит всегда, сетка не сдвигается.
 */
export function CheckChips({
  closed,
  accounts,
  weeks,
  filter,
  onFilterChange,
  hubLine,
  counts,
  onShow,
}: CheckChipsProps) {
  const menu: ItemMenuModel = {
    actions: [
      {
        id: 'done',
        label: counts
          ? `Решённые за 14 дней · ${formatNumber(counts.done)}`
          : 'Решённые за 14 дней',
        onSelect: () => onShow('done'),
      },
      {
        id: 'not-ours',
        label: counts ? `Не наше · ${formatNumber(counts.notOurs)}` : 'Не наше',
        onSelect: () => onShow('not-ours'),
      },
    ],
  }
  const trailing = (
    <div className="flex min-w-0 items-center gap-3">
      {hubLine ? <IntegrationPhrase line={hubLine} withOwnerAction /> : null}
      <ItemMenuButton menu={menu} label="Ещё" />
    </div>
  )

  if (closed) {
    return (
      <FilterChipsRow canReset={false} onReset={() => onShow(null)} trailing={trailing}>
        <Button variant="secondary" size="sm" onClick={() => onShow(null)}>
          <ChevronLeftIcon />
          Сверить
        </Button>
        <span className="text-base">{CLOSED_TITLE[closed]}</span>
      </FilterChipsRow>
    )
  }

  const pageOptions = accounts.map((account) => ({ value: account.code, label: account.label }))
  const pickPage = (next: string[]) => {
    const page = accounts.find((account) => account.code === next[0])?.code
    onFilterChange({ ...filter, page })
  }
  const pickWeek = (next: string[]) => {
    const week = weeks.find((option) => option.value === next[0])?.value
    onFilterChange({ ...filter, week })
  }
  return (
    <FilterChipsRow
      canReset={filter.page !== undefined || filter.week !== undefined}
      onReset={() => onFilterChange({})}
      trailing={trailing}
    >
      <FilterSelectChip
        label="Страница"
        options={pageOptions}
        selected={filter.page ? [filter.page] : []}
        onSelectedChange={pickPage}
      />
      <FilterSelectChip
        label="Неделя"
        options={weeks}
        selected={filter.week ? [filter.week] : []}
        onSelectedChange={pickWeek}
      />
    </FilterChipsRow>
  )
}
