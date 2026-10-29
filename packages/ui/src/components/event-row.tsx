import { cn } from 'cn'
import { BotIcon, ChevronDownIcon, CpuIcon, type LucideIcon, UserIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from './skeleton'

/** Кто действовал (DESIGN §0, п. 5): человек, агент или система. */
export type EventActorKind = 'person' | 'agent' | 'system'

const ACTOR_ICON: Record<EventActorKind, LucideIcon> = {
  person: UserIcon,
  agent: BotIcon,
  system: CpuIcon,
}

const ACTOR_LABEL: Record<EventActorKind, string> = {
  person: 'Человек',
  agent: 'Агент',
  system: 'Система',
}

/**
 * Колонки строки события: время 44, автор 28, фраза, миниатюра 32, «⋯». Раскрытие
 * начинается под фразой, поэтому отступ слева у них общий.
 */
const ROW_GRID = 'grid grid-cols-[2.75rem_1.75rem_minmax(0,1fr)_2rem_2.25rem] items-center gap-3'
const DETAILS_INSET = 'pl-26'

interface EventRowProps {
  /** «13:52» по Москве. */
  time: string
  actor: EventActorKind
  /** Фраза события; объект внутри — ссылкой, у отказа и ошибки красным только слово (§4.18). */
  children: ReactNode
  /** Миниатюра предмета 32 × 32; без предмета место пустое, колонки не съезжают. */
  thumb?: ReactNode
  /** Кнопка «⋯» события: видна при наведении и на выбранной строке. */
  menu?: ReactNode
  expanded: boolean
  selected?: boolean
  className?: string
}

/** Строка журнала 48 (DESIGN §4.18, §7.3): время, значок автора, фраза, миниатюра. */
export function EventRow({
  time,
  actor,
  children,
  thumb,
  menu,
  expanded,
  selected = false,
  className,
}: EventRowProps) {
  const Icon = ACTOR_ICON[actor]
  return (
    <div
      data-slot="event-row"
      data-selected={selected}
      data-expanded={expanded}
      className={cn(
        ROW_GRID,
        'group/event h-12 cursor-default rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint',
        className,
      )}
    >
      <span className="text-ink-3 text-sm tabular-nums">{time}</span>
      <span
        role="img"
        aria-label={ACTOR_LABEL[actor]}
        title={ACTOR_LABEL[actor]}
        className="grid size-7 place-items-center rounded-full bg-secondary text-muted-foreground"
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-base">{children}</span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-ink-3 opacity-0 transition-[opacity,transform] duration-120 group-hover/event:opacity-100 group-data-[expanded=true]/event:rotate-180 group-data-[expanded=true]/event:opacity-100"
        />
      </span>
      <span className="size-8">{thumb}</span>
      <span className="flex justify-end opacity-0 transition-opacity duration-120 group-hover/event:opacity-100 group-data-[selected=true]/event:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-focus-visible:opacity-100">
        {menu}
      </span>
    </div>
  )
}

export interface EventChange {
  field: string
  before: string
  after: string
}

interface EventDetailsProps {
  /** «Было → стало» по полям. */
  changes: readonly EventChange[]
  /** «22.09.2026, 13:52 · Система · Приёмка». */
  meta: string
  className?: string
}

/** Раскрытие события: «было → стало» и строка с полной датой, автором и областью. */
export function EventDetails({ changes, meta, className }: EventDetailsProps) {
  return (
    <div
      data-slot="event-details"
      className={cn('flex flex-col gap-1 pt-1 pr-14 pb-4', DETAILS_INSET, className)}
    >
      {changes.map((change) => (
        <p key={change.field} className="truncate text-base">
          <span className="text-muted-foreground">{change.field}: </span>
          <span className="text-muted-foreground">{change.before}</span>
          <span aria-hidden className="px-1.5 text-ink-3">
            →
          </span>
          <span className="sr-only">стало </span>
          <span>{change.after}</span>
        </p>
      ))}
      <p className="truncate text-ink-3 text-sm leading-5 tabular-nums">{meta}</p>
    </div>
  )
}

/** Заголовок дня ленты: «Сегодня, 22 сентября». */
export function EventDayHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="flex h-11 items-end px-2 pb-2 font-medium text-muted-foreground text-sm">
      {children}
    </h2>
  )
}

/** Заготовка строки события ровно её размеров (§3.10). */
export function EventRowSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn(ROW_GRID, 'h-12 px-2', className)}>
      <Skeleton className="h-3 w-9 rounded-sm" />
      <Skeleton className="size-7 rounded-full" />
      <Skeleton className="h-3.5 w-2/3 max-w-110 rounded-sm" />
      <Skeleton className="size-8 rounded-md" />
      <span />
    </div>
  )
}
