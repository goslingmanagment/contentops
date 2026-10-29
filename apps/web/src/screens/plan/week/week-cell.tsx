import type { AccountCode, LocalDate, PlanRow, SlotGap } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { cn } from '@contentops/ui/lib/utils'
import { useDroppable } from '@dnd-kit/core'
import type { MouseEvent } from 'react'
import { MiniRow } from './mini-row'
import type { WeekDropData } from './week-dnd'
import { type CellItem, GAP_SHORT } from './week-layout'

export interface CellHandlers {
  menuFor: (row: PlanRow) => ItemMenuModel
  selectRow: (row: PlanRow, event: MouseEvent) => void
  openRow: (row: PlanRow) => void
  pickGap: (gap: SlotGap) => void
}

interface WeekCellProps {
  date: LocalDate
  account: AccountCode
  items: readonly CellItem[]
  selectedKeys: ReadonlySet<string>
  past: boolean
  /** Второй вид недели: крупные миниатюры. */
  large?: boolean
  canAct: boolean
  /** Место ячейки в сетке — для стрелок (§4.12). */
  position: { day: number; page: number }
  handlers: CellHandlers
  className?: string
}

/**
 * Ячейка «день × страница» (DESIGN §4.12): стопка мини-строк и пустые места нормы
 * пунктиром. Сюда отпускают плитку из ящика (строка сразу) и строку из другой ячейки
 * (перенос).
 */
export function WeekCell({
  date,
  account,
  items,
  selectedKeys,
  past,
  large = false,
  canAct,
  position,
  handlers,
  className,
}: WeekCellProps) {
  const data: WeekDropData = { kind: 'cell', date, account }
  const drop = useDroppable({ id: `cell:${date}:${account}`, data, disabled: !canAct || past })
  return (
    <div
      ref={drop.setNodeRef}
      data-week-cell=""
      data-day={position.day}
      data-page={position.page}
      tabIndex={-1}
      className={cn(
        'flex min-h-full flex-col gap-0.5 rounded-lg p-1 outline-none transition-colors duration-120 focus-visible:ring-2 focus-visible:ring-ring',
        drop.isOver && 'bg-primary-tint ring-2 ring-primary/40',
        className,
      )}
    >
      {items.map((item) =>
        item.kind === 'row' ? (
          <MiniRow
            key={item.key}
            row={item.row}
            selected={selectedKeys.has(item.row.id)}
            past={past}
            large={large}
            canAct={canAct}
            menu={handlers.menuFor(item.row)}
            onSelect={handlers.selectRow}
            onOpen={handlers.openRow}
          />
        ) : past ? null : (
          <GapSlot key={item.key} gap={item.gap} canAct={canAct} onPick={handlers.pickGap} />
        ),
      )}
    </div>
  )
}

interface GapSlotProps {
  gap: SlotGap
  canAct: boolean
  onPick: (gap: SlotGap) => void
}

/** Пустое место нормы — пунктир 32: «+ фуп», «+ пост на стену»; нажатие — окно «В план». */
function GapSlot({ gap, canAct, onPick }: GapSlotProps) {
  return (
    <button
      type="button"
      disabled={!canAct}
      onClick={() => onPick(gap)}
      className="flex h-8 w-full items-center gap-1 rounded-lg border border-input border-dashed px-2 text-left text-muted-foreground text-xs outline-none transition-colors duration-120 enabled:hover:border-primary enabled:hover:text-primary-ink focus-visible:ring-2 focus-visible:ring-ring disabled:border-line-strong"
    >
      <span className="truncate">{GAP_SHORT[gap.kind]}</span>
      {gap.time ? <span className="ml-auto shrink-0 tabular-nums">{gap.time}</span> : null}
    </button>
  )
}
