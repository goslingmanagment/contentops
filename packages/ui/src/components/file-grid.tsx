import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { hasModifierKey } from '../lib/platform'
import { useCollectionNavigation } from '../lib/use-collection-navigation'
import { useElementWidth } from '../lib/use-element-width'
import { Button } from './button'
import { CollectionOption } from './collection-option'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'
import { Input } from './input'
import { ItemContextMenu, type ItemMenuModel } from './item-menu'

export interface FileCellState {
  index: number
  selected: boolean
  focused: boolean
}

/** Клавиша в сетке кроме стрелок: `1` и `3` у сета. Вернуть `true`, если обработана. */
export type GridKeyAction = (event: KeyboardEvent, index: number, focusNext: () => void) => boolean

/** Что сетка даёт меню файла: «Переместить на позицию…», если порядок меняется. */
export interface FileGridTools {
  moveToPosition?: () => void
}

interface FileGridProps<Item> {
  items: readonly Item[]
  getKey: (item: Item) => string
  renderItem: (item: Item, state: FileCellState) => ReactNode
  /** Ширина ячейки с полями плитки: фото 98 + 8, кадры 82 + 8, черновик 72 (DESIGN §7.6). */
  cellWidth: number
  /** Высота ряда для окон прокрутки (первая оценка, дальше ряды меряются). */
  rowHeight: number
  /** Ровно столько колонок: кадры мастера стоят сеткой 5 × 2 при любой ширине. */
  fixedColumns?: number
  gap?: number
  /** Подпись списка для чтения с экрана: «Фото», «Кадры мастера», «Файлы группы». */
  label: string
  /**
   * Выделение, как во всех списках (`listbox`, §3.3): клик, `Shift`, `Ctrl`/`⌘`, стрелки.
   * Без него — простой список плиток со своими кнопками (черновик «Приехало»).
   */
  selection?: { keys: ReadonlySet<string>; onKeysChange: (next: Set<string>) => void }
  /** Новый порядок всех ключей: перетаскиванием, с клавиатуры и «Переместить на позицию…». */
  onReorder?: (keys: string[]) => void
  onOpen?: (item: Item) => void
  onKeyAction?: GridKeyAction
  /** Правый клик — то же меню, что «⋯» у файла (§3.6). */
  menuFor?: (item: Item, tools: FileGridTools) => ItemMenuModel | null
  /**
   * Прокрутка, внутри которой стоит сетка: больше `WINDOW_FROM` файлов — рисуются только
   * видимые ряды (§3.13, п. 2).
   */
  scrollRef?: RefObject<HTMLElement | null>
  className?: string
}

/** Больше стольких файлов — без перетаскивания мышью (§8); клавиши и меню работают. */
export const DRAG_LIMIT = 200
/** Больше стольких файлов — ряды виртуальные внутри прокрутки. */
const WINDOW_FROM = 200
const GAP = 8
/** Движение начинается после сдвига на 4 px: нажатие на чип роли и галочку — не перетаскивание. */
const DRAG_DISTANCE_PX = 4

/**
 * Сетка файлов — одна на объект и черновик «Приехало» (DESIGN §4.4, §4.8, §8).
 *
 * Порядок меняется тремя путями: перетаскиванием (плитка поднимается с тенью, остальные
 * расступаются; до `DRAG_LIMIT` файлов), с клавиатуры и пунктом «Переместить на
 * позицию…» в меню файла. С клавиатуры: в сетке с выделением — `Alt` + стрелки двигают
 * файл под фокусом; в простом списке — `Space` берёт плитку, стрелки несут, `Space`
 * кладёт. Больше `WINDOW_FROM` файлов — ряды рисуются окнами прокрутки.
 */
export function FileGrid<Item>(props: FileGridProps<Item>) {
  const { items, getKey, onReorder, renderItem } = props
  const keys = useMemo(() => items.map(getKey), [items, getKey])
  const [moving, setMoving] = useState<string | null>(null)
  const sortable = onReorder !== undefined && items.length <= DRAG_LIMIT
  const grid = (
    <GridBody
      {...props}
      keys={keys}
      sortable={sortable}
      onMoveToPosition={onReorder ? setMoving : undefined}
    />
  )
  return (
    <>
      {sortable && onReorder ? (
        <SortableGrid
          keys={keys}
          keyboard={props.selection === undefined}
          onReorder={onReorder}
          renderOverlay={(key) => {
            const index = keys.indexOf(key)
            const item = items[index]
            return item === undefined
              ? null
              : renderItem(item, { index, selected: true, focused: false })
          }}
        >
          {grid}
        </SortableGrid>
      ) : (
        grid
      )}
      {onReorder ? (
        <MoveToPositionDialog
          moving={moving}
          keys={keys}
          onClose={() => setMoving(null)}
          onMove={(next) => {
            onReorder(next)
            setMoving(null)
          }}
        />
      ) : null}
    </>
  )
}

interface GridBodyProps<Item> extends FileGridProps<Item> {
  keys: readonly string[]
  sortable: boolean
  onMoveToPosition?: (key: string) => void
}

function GridBody<Item>({
  items,
  keys,
  renderItem,
  cellWidth,
  rowHeight,
  fixedColumns,
  gap = GAP,
  label,
  selection,
  onReorder,
  onOpen,
  onKeyAction,
  menuFor,
  scrollRef,
  sortable,
  onMoveToPosition,
  className,
}: GridBodyProps<Item>) {
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const width = useElementWidth(listRef)
  const fitting =
    width === 0 ? (fixedColumns ?? 1) : Math.max(1, Math.floor((width + gap) / (cellWidth + gap)))
  const columns = fixedColumns === undefined ? fitting : Math.min(fixedColumns, fitting)
  const windowed = scrollRef !== undefined && items.length > WINDOW_FROM
  const rows = useRowWindow({
    enabled: windowed,
    listRef,
    scrollRef,
    count: Math.ceil(items.length / columns),
    rowHeight: rowHeight + gap,
  })
  const optionId = useCallback((index: number) => `${listId}-${index}`, [listId])
  const open = useCallback(
    (index: number) => {
      const item = items[index]
      if (item !== undefined) {
        onOpen?.(item)
      }
    },
    [items, onOpen],
  )
  const noSelection = useMemo(() => new Set<string>(), [])

  const navigation = useCollectionNavigation({
    keys,
    columns,
    selectedKeys: selection?.keys ?? noSelection,
    onSelectedKeysChange: selection?.onKeysChange ?? (() => undefined),
    scrollToIndex: (index) => {
      if (windowed) {
        rows.scrollToRow(Math.floor(index / columns))
      }
      document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' })
    },
    onOpen: onOpen ? open : undefined,
    onPreview: onOpen ? open : undefined,
  })

  // Фокус для клавиш держится и в ссылке: `1` `1` `3` подряд быстрее отрисовки, и каждое
  // нажатие должно попасть на свой кадр, а не на прежний.
  const focusRef = useRef(navigation.focusIndex)
  useLayoutEffect(() => {
    focusRef.current = navigation.focusIndex
  })
  const moveFocused = (event: KeyboardEvent): boolean => {
    if (!onReorder || !event.altKey || hasModifierKey(event)) {
      return false
    }
    const step =
      event.code === 'ArrowLeft'
        ? -1
        : event.code === 'ArrowRight'
          ? 1
          : event.code === 'ArrowUp'
            ? -columns
            : event.code === 'ArrowDown'
              ? columns
              : 0
    const from = focusRef.current
    const to = Math.min(Math.max(from + step, 0), keys.length - 1)
    if (step === 0 || to === from) {
      return step !== 0
    }
    onReorder(arrayMove([...keys], from, to))
    focusRef.current = to
    navigation.setFocus(to)
    return true
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    const index = focusRef.current
    const focusNext = () => {
      focusRef.current = Math.min(index + 1, items.length - 1)
      navigation.setFocus(focusRef.current)
    }
    if (moveFocused(event) || onKeyAction?.(event, index, focusNext)) {
      event.preventDefault()
      return
    }
    navigation.handleKeyDown(event)
  }

  const cell = (index: number) => {
    const item = items[index]
    const key = keys[index]
    if (item === undefined || key === undefined) {
      return null
    }
    const state = {
      index,
      selected: selection?.keys.has(key) ?? false,
      focused: selection !== undefined && index === navigation.focusIndex,
    }
    const tools: FileGridTools = {
      moveToPosition: onMoveToPosition ? () => onMoveToPosition(key) : undefined,
    }
    const menu = menuFor?.(item, tools) ?? null
    const content = renderItem(item, state)
    // Правый клик ловит обёртка: плитка — компонент экрана и чужих обработчиков не берёт.
    const body = menu ? (
      <ItemContextMenu menu={menu}>
        <div>{content}</div>
      </ItemContextMenu>
    ) : (
      content
    )
    if (!selection) {
      return sortable ? (
        <SortableCell key={key} sortableKey={key} focusable>
          {body}
        </SortableCell>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: в окнах прокрутки плитки стоят в рядах-обёртках, `ul > li` там не сложить
        <div key={key} role="listitem">
          {body}
        </div>
      )
    }
    return (
      <CollectionOption
        key={key}
        id={optionId(index)}
        index={index}
        selected={state.selected}
        focused={state.focused}
        onItemClick={navigation.handleItemClick}
        onItemDoubleClick={navigation.handleItemDoubleClick}
      >
        {sortable ? <SortableCell sortableKey={key}>{body}</SortableCell> : body}
      </CollectionOption>
    )
  }

  const template =
    fixedColumns === undefined
      ? `repeat(auto-fill, ${cellWidth}px)`
      : `repeat(${columns}, ${cellWidth}px)`
  const listProps = selection
    ? {
        role: 'listbox' as const,
        'aria-label': label,
        'aria-multiselectable': true,
        'aria-activedescendant': items.length > 0 ? optionId(navigation.focusIndex) : undefined,
        tabIndex: 0,
        onKeyDown: handleKeyDown,
      }
    : { role: 'list' as const, 'aria-label': label }

  if (windowed) {
    return (
      <div
        ref={listRef}
        {...listProps}
        className={cn('group/collection relative w-full outline-none', className)}
        style={{ height: rows.totalSize }}
      >
        {rows.items.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={rows.measure}
            className="absolute inset-x-0 top-0 grid"
            style={{
              transform: `translateY(${row.start - rows.offset}px)`,
              gridTemplateColumns: template,
              gap,
              paddingBottom: gap,
            }}
          >
            {Array.from({ length: columns }, (_, column) => cell(row.index * columns + column))}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div
      ref={listRef}
      {...listProps}
      className={cn('group/collection grid outline-none', className)}
      style={{ gridTemplateColumns: template, gap }}
    >
      {items.map((_, index) => cell(index))}
    </div>
  )
}

interface RowWindowOptions {
  enabled: boolean
  listRef: RefObject<HTMLDivElement | null>
  scrollRef: RefObject<HTMLElement | null> | undefined
  count: number
  rowHeight: number
}

/** Ряды сетки внутри общей прокрутки панели или страницы: на экране только видимое. */
function useRowWindow({ enabled, listRef, scrollRef, count, rowHeight }: RowWindowOptions) {
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => {
    const list = listRef.current
    const scroller = scrollRef?.current
    if (enabled && list && scroller) {
      setOffset(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      )
    }
  }, [enabled, listRef, scrollRef])
  const virtualizer = useVirtualizer({
    count: enabled ? count : 0,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => rowHeight,
    overscan: 3,
    scrollMargin: offset,
  })
  return {
    items: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    offset,
    measure: virtualizer.measureElement,
    scrollToRow: (row: number) => virtualizer.scrollToIndex(row, { align: 'auto' }),
  }
}

function SortableCell({
  sortableKey,
  focusable = false,
  children,
}: {
  sortableKey: string
  /** В простом списке плитка сама берёт фокус: `Space` — взять, стрелки — нести. */
  focusable?: boolean
  children: ReactNode
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: sortableKey,
  })
  const { role: _role, tabIndex, ...dragAttributes } = attributes
  return (
    <div
      ref={setNodeRef}
      role={focusable ? 'listitem' : undefined}
      tabIndex={focusable ? tabIndex : undefined}
      {...dragAttributes}
      {...listeners}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      className={cn(
        'touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        isDragging && 'opacity-30',
      )}
    >
      {children}
    </div>
  )
}

interface SortableGridProps {
  keys: readonly string[]
  /** Нести плитку с клавиатуры (простой список): ячейки там сами держат фокус. */
  keyboard: boolean
  onReorder: (keys: string[]) => void
  renderOverlay: (key: string) => ReactNode
  children: ReactNode
}

function SortableGrid({ keys, keyboard, onReorder, renderOverlay, children }: SortableGridProps) {
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } })
  const keys_ = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  const sensors = useSensors(pointer, ...(keyboard ? [keys_] : []))
  const [dragged, setDragged] = useState<string | null>(null)
  const onDragStart = (event: DragStartEvent) => setDragged(String(event.active.id))
  const onDragEnd = (event: DragEndEvent) => {
    setDragged(null)
    const over = event.over ? String(event.over.id) : null
    const active = String(event.active.id)
    if (!over || over === active) {
      return
    }
    onReorder(arrayMove([...keys], keys.indexOf(active), keys.indexOf(over)))
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragged(null)}
    >
      <SortableContext items={[...keys]} strategy={rectSortingStrategy}>
        {children}
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {dragged ? <div className="rounded-xl shadow-lg">{renderOverlay(dragged)}</div> : null}
      </DragOverlay>
    </DndContext>
  )
}

interface MoveToPositionDialogProps {
  moving: string | null
  keys: readonly string[]
  onClose: () => void
  onMove: (keys: string[]) => void
}

/** «Переместить на позицию…» (§8): номер места от 1 до числа файлов. */
function MoveToPositionDialog({ moving, keys, onClose, onMove }: MoveToPositionDialogProps) {
  return (
    <Dialog open={moving !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-90">
        {moving === null ? null : (
          <MoveForm
            key={moving}
            from={keys.indexOf(moving)}
            count={keys.length}
            onCancel={onClose}
            onMove={(to) => onMove(arrayMove([...keys], keys.indexOf(moving), to))}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface MoveFormProps {
  from: number
  count: number
  onCancel: () => void
  /** Новое место, считая с нуля. */
  onMove: (to: number) => void
}

function MoveForm({ from, count, onCancel, onMove }: MoveFormProps) {
  const inputId = useId()
  const [value, setValue] = useState(String(from + 1))
  const target = Number.parseInt(value, 10)
  const valid = Number.isInteger(target) && target >= 1 && target <= count
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid) {
      onMove(target - 1)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Переместить на позицию</DialogTitle>
        <DialogDescription>
          Сейчас на {from + 1}-м месте из {count}
        </DialogDescription>
      </DialogHeader>
      <label htmlFor={inputId} className="sr-only">
        Позиция
      </label>
      <Input
        id={inputId}
        type="number"
        inputMode="numeric"
        min={1}
        max={count}
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Отмена
        </Button>
        <Button type="submit" disabled={!valid}>
          Переместить
        </Button>
      </DialogFooter>
    </form>
  )
}
