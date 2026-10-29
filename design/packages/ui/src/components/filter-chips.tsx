import { cn } from 'cn'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Toggle as TogglePrimitive } from 'radix-ui'
import { type ComponentProps, type CSSProperties, type ReactNode, useRef } from 'react'
import { type ScrollEdges, useScrollEdges } from '../lib/use-scroll-edges'
import { Button } from './button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

/** Чип 32 с радиусом 16, 13/18 (DESIGN §3.2, §7.3–7.4); включённый — синий оттенок. */
const chipClass =
  'inline-flex h-8 max-w-72 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-3xl px-3 text-sm transition-colors duration-120 bg-secondary text-secondary-foreground hover:bg-secondary-hover data-[active=true]:bg-primary-tint data-[active=true]:text-primary-ink [&_svg]:size-4 [&_svg]:shrink-0'

interface FilterChipsRowProps {
  children: ReactNode
  /** Что-то включено: справа от чипов появляется «Сбросить». */
  canReset: boolean
  onReset: () => void
  /** Справа в ряду: строка интеграции, если у экрана нет групп (§3.2). */
  trailing?: ReactNode
  className?: string
}

/** Растворение под стрелкой: чип уходит под неё, а не обрывается. */
const FADE = '3rem'

/** Край ряда, за которым прячутся чипы, растворяется: обрезанный чип не выглядит сломанным. */
function fadeMask({ before, after }: ScrollEdges): CSSProperties | undefined {
  if (!before && !after) {
    return undefined
  }
  const start = before ? `transparent 0, black ${FADE}` : 'black 0'
  const end = after ? `black calc(100% - ${FADE}), transparent 100%` : 'black 100%'
  const image = `linear-gradient(to right, ${start}, ${end})`
  return { maskImage: image, WebkitMaskImage: image }
}

/**
 * Ряд чипов стоит всегда, поэтому сетка под ним не сдвигается. Если чипы не помещаются
 * (узкое окно, открыта панель), ряд прокручивается вбок, растворяется у края, и на краю
 * стоит стрелка: видно, что дальше есть чипы, и до них можно докрутить мышью без колеса.
 */
export function FilterChipsRow({
  children,
  canReset,
  onReset,
  trailing,
  className,
}: FilterChipsRowProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const edges = useScrollEdges(scroller, content)
  return (
    <div
      data-slot="filter-chips"
      role="toolbar"
      aria-label="Фильтры"
      className={cn('flex h-8 min-w-0 items-center gap-2', className)}
    >
      <div className="relative flex min-w-0 items-center">
        <div
          ref={scroller}
          className="min-w-0 overflow-x-auto scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto"
          style={fadeMask(edges)}
        >
          <div ref={content} className="flex w-max items-center gap-2">
            {children}
          </div>
        </div>
        {edges.before ? (
          <ScrollArrow side="before" onClick={() => scrollRow(scroller.current, -1)} />
        ) : null}
        {edges.after ? (
          <ScrollArrow side="after" onClick={() => scrollRow(scroller.current, 1)} />
        ) : null}
      </div>
      {canReset ? (
        <Button variant="link" size="sm" onClick={onReset} className="shrink-0 px-1">
          Сбросить
        </Button>
      ) : null}
      {trailing ? <div className="ml-auto flex min-w-0 shrink items-center">{trailing}</div> : null}
    </div>
  )
}

/** Докрутить ряд на две трети видимой ширины. */
function scrollRow(element: HTMLElement | null, direction: 1 | -1) {
  element?.scrollBy({ left: direction * element.clientWidth * 0.66 })
}

function ScrollArrow({ side, onClick }: { side: 'before' | 'after'; onClick: () => void }) {
  const Icon = side === 'before' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <Button
      variant="outline"
      size="icon-sm"
      aria-label={side === 'before' ? 'Чипы левее' : 'Ещё чипы'}
      onClick={onClick}
      className={cn(
        'absolute top-1/2 size-7 -translate-y-1/2 rounded-full shadow-sm',
        side === 'before' ? 'left-0' : 'right-0',
      )}
    >
      <Icon />
    </Button>
  )
}

interface FilterToggleChipProps
  extends Omit<ComponentProps<typeof TogglePrimitive.Root>, 'children'> {
  label: string
}

/** Чип-переключатель: «Без тизера», «Второй человек». */
export function FilterToggleChip({ label, pressed, className, ...props }: FilterToggleChipProps) {
  return (
    <TogglePrimitive.Root
      pressed={pressed}
      data-active={pressed}
      className={cn(chipClass, className)}
      {...props}
    >
      {label}
    </TogglePrimitive.Root>
  )
}

interface FilterChipButtonProps extends ComponentProps<'button'> {
  /** Фильтр включён: чип синеет. */
  active: boolean
}

/** Чип со своей всплывашкой: ввод ID объекта в Журнале и другие фильтры без списка. */
export function FilterChipButton({ active, className, children, ...props }: FilterChipButtonProps) {
  return (
    <button type="button" data-active={active} className={cn(chipClass, className)} {...props}>
      <span className="truncate">{children}</span>
      <ChevronDownIcon aria-hidden />
    </button>
  )
}

export interface FilterOption {
  value: string
  label: string
}

interface FilterSelectChipProps {
  /** «Теги», «Разметка», «Вид». */
  label: string
  options: readonly FilterOption[]
  selected: readonly string[]
  onSelectedChange: (next: string[]) => void
  /** Несколько значений сразу (теги) или одно (вид). */
  multiple?: boolean
  /** Поиск в списке, когда вариантов много. */
  searchPlaceholder?: string
  /** Подпись включённого чипа из выбранного: «Версий нет на Fansly 2». По умолчанию «Теги: …». */
  activeLabel?: (summary: string) => string
}

/** Чип с выбором значений: всплывашка со списком (Popover + Command). */
export function FilterSelectChip({
  label,
  options,
  selected,
  onSelectedChange,
  multiple = false,
  searchPlaceholder,
  activeLabel = (summary) => `${label}: ${summary}`,
}: FilterSelectChipProps) {
  const chosen = options.filter((option) => selected.includes(option.value))
  const summary = chosen.map((option) => option.label).join(', ')
  const toggle = (value: string) => {
    if (!multiple) {
      onSelectedChange(selected.includes(value) ? [] : [value])
      return
    }
    onSelectedChange(
      selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-active={chosen.length > 0} className={chipClass}>
          <span className="truncate">{chosen.length > 0 ? activeLabel(summary) : label}</span>
          <ChevronDownIcon aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0 p-0">
        <Command>
          {searchPlaceholder ? <CommandInput placeholder={searchPlaceholder} /> : null}
          <CommandList>
            <CommandEmpty>Ничего не нашлось</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  checked={selected.includes(option.value)}
                  onSelect={() => toggle(option.value)}
                >
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

interface FilterPopoverChipProps {
  /** Подпись: «Где залито» или, когда включено, «Нет на Fansly 2». */
  label: string
  active: boolean
  /** Содержимое всплывашки: своё, когда списка значений мало (страницы × «есть / нет»). */
  children: ReactNode
  contentClassName?: string
}

/** Чип со своей всплывашкой: «Где залито ▾» (DESIGN §4.2). */
export function FilterPopoverChip({
  label,
  active,
  children,
  contentClassName,
}: FilterPopoverChipProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-active={active} className={chipClass}>
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={cn('w-72', contentClassName)}>
        {children}
      </PopoverContent>
    </Popover>
  )
}
