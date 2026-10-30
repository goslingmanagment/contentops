import type { CatalogEntry, CheckCase, LocalDate, Platform } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { StopRowClick } from '@contentops/ui/components/stop-row-click'
import { cn } from '@contentops/ui/lib/utils'
import { isOpenCase } from '@/data/check'
import { ACTION_LABEL, type CaseAction, rowActions } from './case-kinds'
import { CaseStatus } from './case-status'
import { caseFact, caseSubtitle, caseTitle } from './case-text'
import { CaseThumb } from './case-thumb'
import type { PendingAction } from './use-case-decisions'

interface CaseRowProps {
  entry: CheckCase
  platform: Platform
  /** Наш объект из индекса: его длительность — левая сторона цифр пары. */
  ours: CatalogEntry | undefined
  today: LocalDate
  selected: boolean
  /**
   * Панель пары открыта: решение — в ней, строка остаётся указателем очереди без кнопок,
   * и название не прячется даже на 1280.
   */
  compact: boolean
  /** Действие в пути: его кнопка показывает «…» (DESIGN §3.8). */
  pending: PendingAction | null
  /** Кнопок нет у «только чтение». */
  canDecide: boolean
  menu: ItemMenuModel
  onAction: (action: CaseAction) => void
}

/**
 * Строка случая 64 (DESIGN §4.15): наша миниатюра, «Зеркало, чёрное боди», серым
 * «FYP-0801 версия 1 · фуп · 03:00» — как строка дня плана, чтобы название не пропадало
 * при открытой панели; ◆ и случай словом, под ним цифры пары; справа решение. Решённая
 * строка сереет на месте и теряет кнопки, высота та же.
 */
export function CaseRow({
  entry,
  platform,
  ours,
  today,
  selected,
  compact,
  pending,
  canDecide,
  menu,
  onAction,
}: CaseRowProps) {
  const open = isOpenCase(entry)
  const actions = open && canDecide ? rowActions(entry, platform) : []
  return (
    <ItemContextMenu menu={menu}>
      <div
        className={cn(
          'flex h-16 cursor-default items-center gap-3 rounded-lg px-2 transition-colors duration-120',
          selected ? 'bg-primary-tint' : open && 'hover:bg-accent',
        )}
      >
        <CaseThumb itemId={entry.item_id} surface={entry.surface} dimmed={!open} />
        <div className={cn('min-w-0 flex-1', !open && 'text-muted-foreground')}>
          <p className="truncate text-base">{caseTitle(entry)}</p>
          <p className="truncate text-ink-3 text-sm tabular-nums">
            {entry.version_label ? `${entry.version_label} · ` : null}
            {caseSubtitle(entry, today)}
          </p>
        </div>
        <CaseStatus
          verdict={entry.verdict}
          fact={open ? caseFact(entry, ours) : entry.verdict.detail}
          action={
            open && canDecide
              ? { label: 'Разобрать', onSelect: () => onAction('review') }
              : undefined
          }
          className="w-56 shrink-0"
        />
        {compact ? null : (
          <div className="flex w-54 shrink-0 justify-end gap-2">
            <StopRowClick>
              {actions.map((action) => (
                <Button
                  key={action}
                  variant="outline"
                  pending={pending === action}
                  disabled={pending !== null && pending !== action}
                  onClick={() => onAction(action)}
                >
                  {ACTION_LABEL[action]}
                </Button>
              ))}
            </StopRowClick>
          </div>
        )}
      </div>
    </ItemContextMenu>
  )
}
