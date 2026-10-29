import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import { type KeyboardEvent, useRef } from 'react'
import { Skeleton } from './skeleton'
import { UiLink } from './ui-link'

export interface SectionTab<Value extends string = string> {
  value: Value
  label: string
  /**
   * Серое число после подписи: «Новое 9», «Сверить 8», «Fansly 2 41». Строка — как есть
   * («пусто 7»); `null` — число ещё не пришло, на его месте заготовка той же ширины.
   */
  detail?: number | string | null
  /** Красное после серого: «пропущено 2» у страницы в Неделе (§4.12). */
  alert?: string
  /** Вкладка — свой адрес: переход пишется в историю, «Назад» возвращает вкладку. */
  href?: string
}

interface SectionTabsProps<Value extends string> {
  tabs: readonly SectionTab<Value>[]
  value: Value
  /** Для чтения с экрана: «Вид плана», «Страницы». */
  label: string
  /** Вкладки без адреса переключаются здесь (страница в «Ещё не залито»). */
  onChange?: (value: Value) => void
  /** Узкое место (ящик недели): пилюли ниже; перенос строк — через `className`. */
  size?: 'default' | 'sm'
  className?: string
}

const pillClass = cn(
  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg font-medium text-muted-foreground transition-colors duration-120 hover:text-foreground',
  'aria-[current=page]:bg-secondary aria-[current=page]:text-foreground aria-selected:bg-secondary aria-selected:text-foreground',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
)

const sizeClass = {
  default: 'h-9 px-3 text-base',
  sm: 'h-8 px-2.5 text-sm',
} as const

/**
 * Вкладки раздела — пилюли (DESIGN §3.2, §4.8, §4.11): «День · Неделя · Сверить 8»,
 * «Новое 9 · Решённое», «Все · Заказы · Переделка в PPV», страницы в «Ещё не залито».
 * Выбранная — на сером `--secondary`. Один вид на весь продукт: в шапке встаёт через
 * `FieldHeader.nav` сразу за заголовком.
 *
 * С `href` — это ссылки (`nav`, `aria-current`); без него — вкладки на месте (`tablist`,
 * стрелки переключают).
 */
export function SectionTabs<Value extends string>({
  tabs,
  value,
  label,
  onChange,
  size = 'default',
  className,
}: SectionTabsProps<Value>) {
  const listRef = useRef<HTMLDivElement>(null)
  const linked = tabs.every((tab) => tab.href !== undefined)

  if (linked) {
    return (
      <nav aria-label={label} className={cn('flex items-center gap-1', className)}>
        {tabs.map((tab) => (
          <UiLink
            key={tab.value}
            href={tab.href ?? ''}
            aria-current={tab.value === value ? 'page' : undefined}
            className={cn(pillClass, sizeClass[size])}
          >
            {tab.label}
            <TabDetail detail={tab.detail} />
            <TabAlert alert={tab.alert} />
          </UiLink>
        ))}
      </nav>
    )
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) {
      return
    }
    event.preventDefault()
    const index = tabs.findIndex((tab) => tab.value === value)
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (next) {
      onChange?.(next.value)
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)
        ?.focus()
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className={cn('flex items-center gap-1', className)}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            data-value={tab.value}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange?.(tab.value)}
            className={cn(pillClass, sizeClass[size])}
          >
            {tab.label}
            <TabDetail detail={tab.detail} />
            <TabAlert alert={tab.alert} />
          </button>
        )
      })}
    </div>
  )
}

function TabDetail({ detail }: { detail: SectionTab['detail'] }) {
  if (detail === undefined || detail === '') {
    return null
  }
  if (detail === null) {
    return <Skeleton className="h-3 w-5 rounded-sm" />
  }
  return (
    <span className="font-normal text-ink-3 text-sm tabular-nums">
      {typeof detail === 'number' ? formatNumber(detail) : detail}
    </span>
  )
}

function TabAlert({ alert }: { alert: SectionTab['alert'] }) {
  return alert ? (
    <span className="font-normal text-destructive text-sm tabular-nums">{alert}</span>
  ) : null
}
