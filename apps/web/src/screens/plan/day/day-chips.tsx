import { type Account, type AccountCode, formatNumber } from '@contentops/contracts'
import {
  FilterChipsRow,
  FilterSelectChip,
  FilterToggleChip,
} from '@contentops/ui/components/filter-chips'
import { ItemMenuButton, type MenuAction } from '@contentops/ui/components/item-menu'

interface DayChipsProps {
  accounts: readonly Account[]
  mine: boolean
  onMineChange: (mine: boolean) => void
  pages: readonly AccountCode[]
  onPagesChange: (pages: AccountCode[]) => void
  byTime: boolean
  onByTimeChange: (byTime: boolean) => void
  cancelledCount: number
  showCancelled: boolean
  onShowCancelledChange: (show: boolean) => void
  /** «Отметить выложенное вне плана…»; нет у «только чтение». */
  onOutsidePlan: (() => void) | null
  onReset: () => void
}

/**
 * Ряд чипов дня 40 (DESIGN §4.11): «Мои» (у КМ включён), «Все страницы ▾»; справа «⋯»:
 * «Показать по времени», «Отменённые · 2», «Отметить выложенное вне плана…».
 */
export function DayChips({
  accounts,
  mine,
  onMineChange,
  pages,
  onPagesChange,
  byTime,
  onByTimeChange,
  cancelledCount,
  showCancelled,
  onShowCancelledChange,
  onOutsidePlan,
  onReset,
}: DayChipsProps) {
  const actions: MenuAction[] = [
    byTime
      ? { id: 'by-page', label: 'Показать по страницам', onSelect: () => onByTimeChange(false) }
      : { id: 'by-time', label: 'Показать по времени', onSelect: () => onByTimeChange(true) },
    showCancelled
      ? {
          id: 'hide-cancelled',
          label: 'Скрыть отменённые',
          onSelect: () => onShowCancelledChange(false),
        }
      : {
          id: 'cancelled',
          label: `Отменённые · ${formatNumber(cancelledCount)}`,
          disabled: cancelledCount === 0,
          onSelect: () => onShowCancelledChange(true),
        },
  ]
  if (onOutsidePlan) {
    actions.push({
      id: 'outside',
      label: 'Отметить выложенное вне плана…',
      onSelect: onOutsidePlan,
    })
  }
  return (
    <div className="flex h-10 shrink-0 items-center gap-2">
      <FilterChipsRow
        className="min-w-0 flex-1"
        canReset={pages.length > 0 || byTime}
        onReset={onReset}
      >
        <FilterToggleChip label="Мои" pressed={mine} onPressedChange={onMineChange} />
        <FilterSelectChip
          label={pages.length > 0 ? 'Страницы' : 'Все страницы'}
          options={accounts.map((account) => ({ value: account.code, label: account.label }))}
          selected={pages}
          onSelectedChange={onPagesChange}
          multiple
        />
      </FilterChipsRow>
      <ItemMenuButton menu={{ actions }} size="icon-sm" label="Ещё о дне" />
    </div>
  )
}
