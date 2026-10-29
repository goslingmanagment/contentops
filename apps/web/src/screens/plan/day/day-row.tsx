import type { PlanRow } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { stopRowClick } from '@contentops/ui/components/stop-row-click'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { cn } from '@contentops/ui/lib/utils'
import { DownloadIcon } from 'lucide-react'
import type { DragEvent, ReactNode } from 'react'
import { carriesFiles } from '@/shell/upload/use-file-drag'
import { MarkControl } from '../shared/mark-control'
import {
  copyCaption,
  isDoneRow,
  rowSubtitle,
  rowTitle,
  rowWarningCaption,
} from '../shared/plan-text'
import { RowStatus } from '../shared/row-status'
import { RowThumb } from '../shared/row-thumb'

interface DayRowProps {
  row: PlanRow
  /** Вид «по времени»: страница строки впереди подписи. */
  accountLabel?: string | null
  selected: boolean
  canAct: boolean
  menu: ItemMenuModel
  onCheck: () => void
  onUploadMontage: () => void
  onDownload: () => void
  /** Файлы, которые тащат на строку, ждущую монтаж, станут монтажом для неё (§3.7). */
  onFilesOver?: (over: boolean) => void
  markMenuOpen: boolean
  onMarkMenuOpenChange: (open: boolean) => void
}

/**
 * Строка дня 54 (DESIGN §4.11): время, миниатюра, название и подпись, состояние со словом
 * «почему», «↓» и одна кнопка по случаю. Высота не меняется никогда, сделанная строка сереет.
 */
export function DayRow({
  row,
  accountLabel = null,
  selected,
  canAct,
  menu,
  onCheck,
  onUploadMontage,
  onDownload,
  onFilesOver,
  markMenuOpen,
  onMarkMenuOpenChange,
}: DayRowProps) {
  const done = isDoneRow(row) || row.cancelled !== null
  const dropHandlers = onFilesOver
    ? {
        onDragEnter: (event: DragEvent) => carriesFiles(event) && onFilesOver(true),
        onDragLeave: (event: DragEvent) => {
          const inside =
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          if (carriesFiles(event) && !inside) {
            onFilesOver(false)
          }
        },
      }
    : {}
  return (
    <ItemContextMenu menu={menu}>
      <div
        {...dropHandlers}
        data-selected={selected}
        className={cn(
          'flex h-13.5 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
          done && 'text-muted-foreground',
        )}
      >
        <RowTime time={row.time} />
        <RowThumb row={row} />
        <RowTitle row={row} accountLabel={accountLabel} />
        <RowStatus row={row} canAct={canAct} onCheck={onCheck} className={STATUS_COLUMN} />
        <RowActions>
          {row.manifest && canAct && !row.cancelled ? (
            <RowDownload row={row} onDownload={onDownload} />
          ) : null}
          <MarkControl
            row={row}
            canAct={canAct}
            onCheck={onCheck}
            onUploadMontage={onUploadMontage}
            menuOpen={markMenuOpen}
            onMenuOpenChange={onMarkMenuOpenChange}
          />
        </RowActions>
      </div>
    </ItemContextMenu>
  )
}

/**
 * Название и состояние делят место 3 : 2 (§4.11). Колонка состояния — от 136 до 280: на
 * узком окне с открытой панелью в ней целиком «✓ подтверждено» и «Hub нашёл похожее», на
 * широком — причина «Hub видит не все посты этой страницы». Колонка действий — по самой
 * широкой кнопке дня (`row-actions-width.ts`), остальное место уходит названию.
 */
export const TITLE_COLUMN = 'min-w-0 flex-[3_1_0%]'
export const STATUS_COLUMN = 'min-w-34 max-w-70 flex-[2_1_0%]'

/** Время 14 табличное; у строки без времени — «весь день», у места нормы без времени — пусто. */
export function RowTime({ time, allDay = true }: { time: string | null; allDay?: boolean }) {
  if (time) {
    return <span className="w-14 shrink-0 text-base tabular-nums">{time}</span>
  }
  return (
    <span className="w-14 shrink-0 whitespace-nowrap text-ink-3 text-sm">
      {allDay ? 'весь день' : ''}
    </span>
  )
}

function RowTitle({ row, accountLabel }: { row: PlanRow; accountLabel: string | null }) {
  const warning = rowWarningCaption(row)
  return (
    <div className={cn('flex flex-col', TITLE_COLUMN)}>
      <span className={cn('truncate text-base', !row.manifest && 'text-muted-foreground')}>
        {rowTitle(row)}
      </span>
      <span className="truncate text-ink-3 text-sm">
        {accountLabel ? `${accountLabel} · ` : ''}
        {rowSubtitle(row)}
        {warning ? <span className="text-attention-ink"> · {warning}</span> : null}
      </span>
    </div>
  )
}

/**
 * Кнопки строки: нажатие по ним не выделяет строку, чтобы «Отметить» не открывало панель.
 * Ширина — общая для списка (`--row-actions`).
 */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: только гасит всплытие нажатия к строке-варианту списка
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши строки обрабатывает список-владелец
    <div
      className="flex w-(--row-actions,15rem) shrink-0 items-center justify-end gap-1"
      onClick={stopRowClick}
      onDoubleClick={stopRowClick}
    >
      {children}
    </div>
  )
}

function RowDownload({ row, onDownload }: { row: PlanRow; onDownload: () => void }) {
  const file = row.manifest?.files[0]
  const copy = copyCaption(row)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Скачать для заливки"
          onClick={onDownload}
        >
          <DownloadIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md flex-col items-start gap-0.5">
        <span>Скачать для заливки{copy ? ` · ${copy}` : ''}</span>
        {file ? <span className="font-mono text-xs">{file.download_name}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}
