import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  Grid3x3Icon,
  InfoIcon,
  LayoutGridIcon,
  ListIcon,
} from 'lucide-react'
import {
  type ComponentProps,
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from './breadcrumb'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { ItemMenuButton, type ItemMenuModel } from './item-menu'
import type { ObjectTileView } from './object-tile'
import { ToggleGroup, ToggleGroupItem } from './toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'
import { UiLink } from './ui-link'

export interface Crumb {
  label: string
  href?: string
}

export interface SortOption {
  value: string
  label: string
  /**
   * Подменю выбора страницы: «Давно не было на ▾», «Лучше зашёл на ▾». Подпись кнопки
   * складывается из двух: «Давно не было на Fansly 2».
   */
  options?: readonly SortOption[]
}

interface FieldHeaderProps {
  /** «Библиотека › PPV». */
  crumbs?: readonly Crumb[]
  title: string
  /** Серое число после заголовка. */
  count?: number
  /** Серая подпись после заголовка вместо числа: «Лора · 1 391 объект» у корня Библиотеки. */
  meta?: string
  /**
   * Строка интеграции раздела (DESIGN §3.11): в строке заголовка после числа, а при
   * вкладках — справа перед управлением; сжимается первой. Ряд чипов остаётся чипам.
   */
  note?: ReactNode
  /** «Сортировка ▾»: не больше четырёх вариантов у вида. */
  sort?: { value: string; options: readonly SortOption[]; onChange: (value: string) => void }
  /** Вид из трёх значков; запоминается на раздел. */
  view?: {
    value: ObjectTileView
    onChange: (value: ObjectTileView) => void
    options?: readonly ObjectTileView[]
  }
  /** `ⓘ` — панель сведений, клавиша `i`. */
  info?: { open: boolean; onToggle: () => void }
  menu?: ItemMenuModel
  /**
   * Вкладки раздела (`SectionTabs`) сразу за заголовком: «План» и «День · Неделя ·
   * Сверить 8» (§4.11), «Кастомы» и «Все · Заказы · Переделка в PPV» (§4.16).
   */
  nav?: ReactNode
  /** Своё управление слева от сортировки (`HeaderAction`): «Нормы», «В план», «Новый заказ». */
  actions?: ReactNode
  /** Полоса выделения: встаёт на место шапки, высота та же. */
  selectionBar?: ReactNode
  className?: string
}

const viewIcons: Record<ObjectTileView, { label: string; Icon: typeof ListIcon }> = {
  large: { label: 'Крупная плитка', Icon: LayoutGridIcon },
  tile: { label: 'Плитка', Icon: Grid3x3Icon },
  row: { label: 'Список', Icon: ListIcon },
}

/**
 * Как шапка ужимается, когда управление не входит (панель открыта, окно 1280):
 * `full` — всё видно; `no-view` — спрятан вид из трёх значков; `icons` — у сортировки и
 * кнопок остаются значки (подпись — в подсказке); `squeeze` — последнее: кнопки с
 * `collapse="truncate"` и заголовок обрезаются многоточием. Заголовок и вкладки до
 * последней ступени не трогаются.
 */
export type FieldHeaderFit = 'full' | 'no-view' | 'icons' | 'squeeze'

const FITS: readonly FieldHeaderFit[] = ['full', 'no-view', 'icons', 'squeeze']

const FieldHeaderFitContext = createContext<FieldHeaderFit>('full')

/**
 * Ступень ужатия подбирается замером: после отрисовки, пока ряд шире места, шапка
 * переходит на следующую ступень (до отрисовки кадра, без мигания). При смене ширины
 * подбор начинается заново с `full`.
 */
function useHeaderFit(
  rowRef: RefObject<HTMLDivElement | null>,
  headerRef: RefObject<HTMLElement | null>,
) {
  const [level, setLevel] = useState(0)

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row || level >= FITS.length - 1) {
      return
    }
    // Не входит: ряд вылез за край или заголовок уже обрезан многоточием.
    const title = row.querySelector<HTMLElement>('[data-slot=field-title]')
    const overflows = row.scrollWidth > row.clientWidth + 1
    const titleCut = title !== null && title.scrollWidth > title.clientWidth + 1
    if (overflows || titleCut) {
      setLevel(level + 1)
    }
  })

  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header || typeof ResizeObserver === 'undefined') {
      return
    }
    let width = header.getBoundingClientRect().width
    const observer = new ResizeObserver(([entry]) => {
      const next = entry?.contentRect.width ?? width
      if (Math.abs(next - width) < 1) {
        return
      }
      width = next
      flushSync(() => setLevel(0))
    })
    observer.observe(header)
    return () => observer.disconnect()
  }, [headerRef])

  return FITS[level] ?? 'full'
}

/** Шапка поля 72 (DESIGN §3.2): крошки и заголовок слева, вкладки за ним, управление видом справа. */
export function FieldHeader({
  crumbs,
  title,
  count,
  meta,
  note,
  sort,
  view,
  info,
  menu,
  nav,
  actions,
  selectionBar,
  className,
}: FieldHeaderProps) {
  const headerRef = useRef<HTMLElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const fit = useHeaderFit(rowRef, headerRef)
  const squeezed = fit === 'squeeze'
  return (
    <header
      ref={headerRef}
      data-slot="field-header"
      data-fit={fit}
      className={cn('group/field-header flex h-18 shrink-0 items-center', className)}
    >
      {/* Полоса выделения встаёт на место шапки, только если она что-то нарисовала: полоса
          без действий возвращает null, и шапка остаётся (§3.3). */}
      {selectionBar ? (
        <div data-slot="selection-bar-slot" className="min-w-0 flex-1 empty:hidden">
          {selectionBar}
        </div>
      ) : null}
      <FieldHeaderFitContext value={fit}>
        <div
          ref={rowRef}
          className="flex min-w-0 flex-1 items-center gap-4 duration-120 animate-in fade-in-0 group-has-[[data-slot=selection-bar-slot]:not(:empty)]/field-header:hidden"
        >
          <div className={cn('flex min-w-0 flex-col', nav || !note ? 'flex-initial' : 'flex-1')}>
            {crumbs && crumbs.length > 0 ? <FieldCrumbs crumbs={crumbs} /> : null}
            {note && !nav ? (
              <div className="flex min-w-0 items-center gap-4">
                {/* Строка интеграции сжимается первой: её вес сжатия в тысячу раз больше. */}
                <FieldTitle title={title} count={count} meta={meta} />
                <div className="flex min-w-0 shrink-[1000] items-center">{note}</div>
              </div>
            ) : (
              <FieldTitle
                title={title}
                count={count}
                meta={meta}
                wrap={!crumbs || crumbs.length === 0}
              />
            )}
          </div>
          {nav ? <div className="flex shrink-0 items-center">{nav}</div> : null}
          {nav || !note ? (
            // Середина между вкладками и управлением: строка интеграции прижата вправо и
            // сжимается первой.
            <div className="flex min-w-0 flex-1 items-center justify-end">{nav ? note : null}</div>
          ) : null}
          <div
            className={cn(
              'flex shrink-0 items-center justify-end gap-2',
              // На последней ступени место отдают кнопки `collapse="truncate"` — раньше
              // заголовка (вес сжатия в тысячу раз больше).
              squeezed &&
                'has-[[data-collapse=truncate]]:min-w-0 has-[[data-collapse=truncate]]:shrink-[1000]',
            )}
          >
            {actions}
            {sort ? <SortMenu {...sort} iconOnly={fit === 'icons' || squeezed} /> : null}
            {view && fit === 'full' ? <ViewSwitch {...view} /> : null}
            {info ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Сведения"
                aria-pressed={info.open}
                onClick={info.onToggle}
                className="aria-pressed:bg-primary-tint aria-pressed:[&_svg]:text-primary"
              >
                <InfoIcon />
              </Button>
            ) : null}
            {menu ? <ItemMenuButton menu={menu} label="Действия раздела" /> : null}
          </div>
        </div>
      </FieldHeaderFitContext>
    </header>
  )
}

type HeaderActionProps = Omit<ComponentProps<typeof Button>, 'children' | 'asChild'> & {
  icon: ReactNode
  label: string
  /**
   * Как кнопка уступает место: `icon` — на ступени `icons` остаётся значок, подпись уходит
   * в подсказку («Нормы», «В план»); `truncate` — подпись видна до последней ступени и
   * там обрезается многоточием («Подтвердить однозначные · 2», §4.15).
   */
  collapse?: 'icon' | 'truncate'
  /** Кнопка-ссылка: «Нормы» ведёт в настройки страницы. */
  href?: string
}

/**
 * Кнопка управления в шапке поля (серая по умолчанию, §7.1: синяя в шапке не ставится,
 * если открыта панель). Ужимается вместе с шапкой по `collapse`.
 */
export function HeaderAction({
  icon,
  label,
  collapse = 'icon',
  href,
  variant = 'secondary',
  className,
  ...props
}: HeaderActionProps) {
  const fit = useContext(FieldHeaderFitContext)
  const iconOnly = collapse === 'icon' && (fit === 'icons' || fit === 'squeeze')
  const truncate = collapse === 'truncate' && fit === 'squeeze'
  const body = (
    <>
      {icon}
      {iconOnly ? null : <span className="min-w-0 truncate">{label}</span>}
    </>
  )
  const button = (
    <Button
      variant={variant}
      size={iconOnly ? 'icon' : 'default'}
      aria-label={iconOnly ? label : undefined}
      asChild={href !== undefined}
      data-collapse={collapse}
      className={cn(truncate && 'min-w-0 shrink', className)}
      {...props}
    >
      {href !== undefined ? <UiLink href={href}>{body}</UiLink> : body}
    </Button>
  )
  if (!iconOnly) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Заголовок и серое число или подпись. Без крошек в шапке 72 есть место на вторую строку:
 * серая подпись, которая не помещается рядом, переносится под заголовок целиком, а не
 * обрезается («Библиотека Лора · 1 391 объект» при 1280 с панелью).
 */
function FieldTitle({
  title,
  count,
  meta,
  wrap = false,
  className,
}: Pick<FieldHeaderProps, 'title' | 'count' | 'meta' | 'className'> & { wrap?: boolean }) {
  const grey = meta ?? (count === undefined ? null : formatNumber(count))
  if (wrap) {
    return (
      <h1
        className={cn(
          'flex min-w-0 flex-wrap items-baseline gap-x-2 font-heading text-xl',
          className,
        )}
      >
        <span data-slot="field-title" className="min-w-0 truncate">
          {title}
        </span>
        {grey === null ? null : (
          <span className="min-w-0 truncate font-normal font-sans text-ink-3 tabular-nums">
            {grey}
          </span>
        )}
      </h1>
    )
  }
  return (
    <h1 data-slot="field-title" className={cn('min-w-0 truncate font-heading text-xl', className)}>
      {title}
      {grey === null ? null : (
        <span className="ml-2 font-normal font-sans text-ink-3 tabular-nums">{grey}</span>
      )}
    </h1>
  )
}

function FieldCrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${crumb.href ?? ''}`}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              {crumb.href ? (
                <BreadcrumbLink asChild>
                  <UiLink href={crumb.href}>{crumb.label}</UiLink>
                </BreadcrumbLink>
              ) : (
                crumb.label
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

/** Выбранный вариант и подпись для кнопки, с учётом подменю страниц. */
function currentSort(
  options: readonly SortOption[],
  value: string,
): { option: SortOption; label: string } | undefined {
  for (const option of options) {
    if (option.value === value) {
      return { option, label: option.label }
    }
    const nested = option.options?.find((child) => child.value === value)
    if (nested) {
      return { option: nested, label: `${option.label} ${nested.label}` }
    }
  }
  return undefined
}

function SortMenu({
  value,
  options,
  onChange,
  iconOnly,
}: NonNullable<FieldHeaderProps['sort']> & { iconOnly: boolean }) {
  const current = currentSort(options, value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size={iconOnly ? 'icon' : 'default'}
          aria-label={`Сортировка: ${current?.label ?? ''}`}
          title={iconOnly ? `Сортировка: ${current?.label ?? ''}` : undefined}
        >
          <ArrowUpDownIcon />
          {iconOnly ? null : (
            <>
              {current?.label ?? 'Сортировка'}
              <ChevronDownIcon className="-mr-1 size-4 text-ink-3" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) =>
            option.options ? (
              <DropdownMenuSub key={option.value}>
                <DropdownMenuSubTrigger>{option.label}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {option.options.map((child) => (
                    <DropdownMenuRadioItem key={child.value} value={child.value}>
                      {child.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ),
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ViewSwitch({
  value,
  onChange,
  options = ['large', 'tile', 'row'],
}: NonNullable<FieldHeaderProps['view']>) {
  return (
    <ToggleGroup
      type="single"
      variant="segment"
      value={value}
      onValueChange={(next) => {
        const selected = options.find((option) => option === next)
        if (selected) {
          onChange(selected)
        }
      }}
      aria-label="Вид"
    >
      {options.map((option) => {
        const { label, Icon } = viewIcons[option]
        return (
          <Tooltip key={option}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={option} aria-label={label}>
                <Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </ToggleGroup>
  )
}
