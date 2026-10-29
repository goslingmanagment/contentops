import type { PlanRow } from '@contentops/contracts'
import { SURFACE_LABEL } from '@contentops/contracts'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { StatusWord } from '@contentops/ui/components/status-word'
import { cn } from '@contentops/ui/lib/utils'
import { useDraggable } from '@dnd-kit/core'
import type { MouseEvent } from 'react'
import { isDoneRow, rowTitle, shortVerdictWord } from '../shared/plan-text'
import { RowWhy } from '../shared/row-status'
import { RowThumb } from '../shared/row-thumb'
import type { WeekDragData } from './week-dnd'
import { canMove } from './week-layout'

interface MiniRowProps {
  row: PlanRow
  selected: boolean
  /** Прошедший день: 32, только название и слово. */
  past: boolean
  /** Второй вид недели: миниатюра 64 и строка выше. */
  large?: boolean
  canAct: boolean
  menu: ItemMenuModel
  onSelect: (row: PlanRow, event: MouseEvent) => void
  onOpen: (row: PlanRow) => void
}

/** «фуп · версия 2» — место и версия после времени во второй строке мини-строки. */
function miniCaption(row: PlanRow): string {
  const version = row.manifest?.fyp_version
  return [SURFACE_LABEL[row.surface], version ? `версия ${version.no}` : null]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Мини-строка недели 44 (DESIGN §4.12): миниатюра 28 × 37, название в одну строку, ниже
 * время, место и слово состояния, если оно не «в плане». Сделанная бледнее, высота та
 * же. Строку можно перетащить в другую ячейку — это перенос.
 */
export function MiniRow({
  row,
  selected,
  past,
  large = false,
  canAct,
  menu,
  onSelect,
  onOpen,
}: MiniRowProps) {
  const data: WeekDragData = { kind: 'row', row }
  const draggable = canAct && canMove(row)
  const drag = useDraggable({ id: `row:${row.id}`, data, disabled: !draggable })
  // Строку, которую нельзя тащить, всё равно выделяют и открывают: от dnd-kit берём только
  // подсказку для чтения с экрана и обработчики, и только когда тащить можно.
  const dragProps = draggable
    ? {
        ...drag.listeners,
        'aria-roledescription': drag.attributes['aria-roledescription'],
        'aria-describedby': drag.attributes['aria-describedby'],
      }
    : {}
  const done = isDoneRow(row)
  const showWord = row.verdict.level !== 'planned'
  // Вся строка — одна кнопка выбора под содержимым, а слово состояния — своя кнопка «почему»
  // поверх неё (§5.1): кнопки не вкладываются друг в друга.
  return (
    <ItemContextMenu menu={menu}>
      <div
        ref={drag.setNodeRef}
        data-selected={selected}
        className={cn(
          'relative flex w-full items-center gap-2 rounded-lg px-1.5 text-left transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
          past ? 'h-8' : large ? 'min-h-20 items-start py-1' : 'h-11',
          done && 'text-muted-foreground',
          drag.isDragging && 'opacity-40',
        )}
      >
        <button
          type="button"
          {...dragProps}
          aria-pressed={selected}
          aria-label={[row.time, rowTitle(row), row.verdict.word].filter(Boolean).join(', ')}
          onClick={(event) => onSelect(row, event)}
          onDoubleClick={() => onOpen(row)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onOpen(row)
            }
          }}
          className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {past ? null : <RowThumb row={row} size={large ? 'large' : 'mini'} />}
        {past ? <PastText row={row} showWord={showWord} /> : null}
        {!past && large ? <LargeText row={row} showWord={showWord} /> : null}
        {!past && !large ? <MiniText row={row} showWord={showWord} /> : null}
      </div>
    </ItemContextMenu>
  )
}

interface RowTextProps {
  row: PlanRow
  /** Слово состояния, если оно не «в плане». */
  showWord: boolean
}

/**
 * Слово состояния в тесной ячейке (§5.1): у ✓ — только знак, у ◆ ▲ — знак и короткое
 * слово целиком («◆ сверить», «▲ нельзя»), у серых слов — слово с многоточием. Нажатие
 * открывает «почему» поверх кнопки строки; полное слово с причиной — в подсказке. `fill` —
 * серое слово после места через точку: оно берёт только остаток строки и уступает раньше
 * места и времени.
 */
function RowWord({
  row,
  fill = false,
  className,
}: {
  row: PlanRow
  fill?: boolean
  className?: string
}) {
  const { sign, word, reason } = row.verdict
  const hint = [word, reason].filter(Boolean).join(' · ')
  if (sign === 'done') {
    return (
      <RowWhy row={row} size="xs" hint={hint} className="relative shrink-0">
        <StatusSign kind="done" size={12} label={word} />
      </RowWhy>
    )
  }
  return (
    <RowWhy
      row={row}
      size="xs"
      hint={hint}
      className={cn('relative min-w-0', fill ? 'flex-1 basis-0' : sign && 'shrink-0', className)}
    >
      <StatusWord sign={sign ?? undefined} size="xs" className="max-w-full">
        {fill ? `· ${word}` : sign ? shortVerdictWord(word) : word}
      </StatusWord>
    </RowWhy>
  )
}

/**
 * Время, место и слово. У ◆ ▲ слово со знаком не режется: место берёт остаток строки и в
 * узкой ячейке (1280, 1440) уходит совсем — «03:00 ◆ сверить», а не «03:00 · фу… ◆ св…». Серое
 * слово, наоборот, само берёт остаток после места и уступает первым.
 */
function SlotLine({ row, showWord }: RowTextProps) {
  const signed = showWord && row.verdict.sign !== null
  const word = signed && row.verdict.sign !== 'done'
  return (
    <span className="@container/slot flex min-w-0 items-center gap-1 overflow-hidden text-ink-3 text-xs">
      {row.time ? <span className="shrink-0 tabular-nums">{row.time}</span> : null}
      <span
        className={cn(
          'truncate',
          signed ? 'min-w-0 flex-1 basis-0' : 'min-w-9',
          word && '@max-[11rem]/slot:hidden',
        )}
      >
        {row.time ? '· ' : ''}
        {miniCaption(row)}
      </span>
      {showWord ? <RowWord row={row} fill={!signed} /> : null}
    </span>
  )
}

/** Название в одну строку, ниже время, место и слово; ничего не выходит за ячейку. */
function MiniText({ row, showWord }: RowTextProps) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm">{rowTitle(row)}</span>
      <SlotLine row={row} showWord={showWord} />
    </span>
  )
}

/**
 * Второй вид недели: название в две строки, под ним «20:00 · стена» — по нему различаются
 * одинаковые названия выпуска, — и слово своей строкой. В узкой плитке место уходит на
 * следующую строку целиком, а не обрезается до буквы.
 */
function LargeText({ row, showWord }: RowTextProps) {
  const caption = miniCaption(row)
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="line-clamp-2 text-sm leading-4.5">{rowTitle(row)}</span>
      <span className="flex min-w-0 flex-wrap gap-x-1 text-ink-3 text-xs tabular-nums">
        {row.time ? <span className="shrink-0">{row.time}</span> : null}
        {caption ? (
          <span className="min-w-0 truncate">
            {row.time ? '· ' : ''}
            {caption}
          </span>
        ) : null}
      </span>
      {showWord ? (
        <span className="flex min-w-0">
          <RowWord row={row} />
        </span>
      ) : null}
    </span>
  )
}

/**
 * Прошедший день: 32, только название и слово; название важнее слова. Серое слово идёт
 * после названия через точку и уступает первым, но не короче 40; ✓ ◆ ▲ — у правого края,
 * название не уже 48.
 */
function PastText({ row, showWord }: RowTextProps) {
  const signed = showWord && row.verdict.sign !== null
  const gray = showWord && !signed
  return (
    <span
      className={cn('flex min-w-0 flex-1 items-center overflow-hidden', gray ? 'gap-1' : 'gap-2')}
    >
      <span className={cn('min-w-12 truncate text-sm', !gray && 'flex-1')}>{rowTitle(row)}</span>
      {showWord ? (
        <RowWord row={row} fill={gray} className={gray ? 'min-w-10' : undefined} />
      ) : null}
    </span>
  )
}
