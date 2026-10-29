import { cn } from 'cn'
import { ChevronDownIcon, ChevronUpIcon, XIcon } from 'lucide-react'
import { useCallback } from 'react'
import { useLayoutWatch } from '../lib/use-layout-watch'
import { Button } from './button'
import { ItemMenuButton } from './item-menu'
import { Progress } from './progress'
import { StatusWord } from './status-word'

export type UploadTrayItemState = 'running' | 'done' | 'interrupted' | 'failed'

export interface UploadTrayItem {
  id: string
  /** Имя файла или сборки: «IMG_1610.JPG», «Архив дня готов · Fansly 1». */
  name: string
  /** Имя файла набирается моноширинным (§7.2); подпись сборки — обычным. */
  nameIsFile?: boolean
  /** «1,2 из 3,4 ГБ», «40 %», «проверяется», «60 МБ». */
  detail: string
  progress?: number
  state: UploadTrayItemState
  /** «Скачать» у готовой сборки. */
  action?: { label: string; onSelect: () => void }
}

interface UploadTrayProps {
  /** «Загружается 3 из 5 · 1,2 из 3,4 ГБ». */
  title: string
  items: readonly UploadTrayItem[]
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  onCancelAll?: () => void
  /** «Загрузка прервана · Продолжить»: человек выбирает тот же файл. */
  onResume?: (id: string) => void
  /** Убрать лоток, когда всё закончилось. */
  onClose?: () => void
  /**
   * Что не закрывать: панели справа в поле (`main aside`). Лоток встаёт левее самой левой
   * из них, чтобы не прятать низ панели решения.
   */
  avoid?: string
  className?: string
}

const EDGE_GAP_PX = 16

/** Отступ лотка справа: у края окна или левее панели, которую нельзя закрывать. */
function rightOffset(avoid: string): number {
  let left = Number.POSITIVE_INFINITY
  for (const element of document.querySelectorAll<HTMLElement>(avoid)) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      left = Math.min(left, rect.left)
    }
  }
  return Number.isFinite(left) ? window.innerWidth - left + EDGE_GAP_PX : EDGE_GAP_PX
}

function useRightOffset(avoid: string | undefined): number {
  // Панель открывается и закрывается вместе с экраном: лоток переезжает следом.
  const measure = useCallback(() => (avoid ? rightOffset(avoid) : EDGE_GAP_PX), [avoid])
  return useLayoutWatch(measure, EDGE_GAP_PX, avoid !== undefined)
}

/**
 * Лоток хода загрузки и долгих сборок (DESIGN §3.7), как у Я.Диска: внизу справа,
 * 360 × до 240, сворачивается и остаётся при переходе между экранами.
 */
export function UploadTray({
  title,
  items,
  collapsed,
  onCollapsedChange,
  onCancelAll,
  onResume,
  onClose,
  avoid,
  className,
}: UploadTrayProps) {
  const right = useRightOffset(avoid)
  return (
    <section
      data-slot="upload-tray"
      aria-label="Загрузки"
      style={{ right }}
      className={cn(
        'fixed bottom-4 z-40 flex w-90 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md transition-[right] duration-160 motion-reduce:transition-none',
        className,
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
        <h2
          className="min-w-0 flex-1 truncate font-medium text-base tabular-nums"
          aria-live="polite"
        >
          {title}
        </h2>
        {onCancelAll ? (
          <ItemMenuButton
            size="icon-sm"
            label="Действия загрузок"
            menu={{
              actions: [],
              dangerActions: [{ id: 'cancel', label: 'Отменить загрузки', onSelect: onCancelAll }],
            }}
          />
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Развернуть' : 'Свернуть'}
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
        {onClose ? (
          <Button variant="ghost" size="icon-sm" aria-label="Убрать лоток" onClick={onClose}>
            <XIcon />
          </Button>
        ) : null}
      </header>
      {collapsed ? null : (
        <ul className="max-h-48 overflow-y-auto border-border border-t py-1">
          {items.map((item) => (
            <li key={item.id} className="flex flex-col gap-1.5 px-4 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    'min-w-0 truncate',
                    item.nameIsFile ? 'font-mono text-xs' : 'text-sm',
                  )}
                  title={item.name}
                >
                  {item.name}
                </span>
                <TrayItemState item={item} onResume={onResume} />
              </div>
              {item.state === 'running' ? (
                <Progress value={item.progress ?? 0} aria-label={item.name} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function TrayItemState({
  item,
  onResume,
}: {
  item: UploadTrayItem
  onResume?: (id: string) => void
}) {
  if (item.state === 'interrupted') {
    return (
      <span className="shrink-0 text-sm">
        <StatusWord sign="trouble">Загрузка прервана</StatusWord>
        {onResume ? (
          <>
            {' · '}
            <Button variant="link" size="inline" onClick={() => onResume(item.id)}>
              Продолжить
            </Button>
          </>
        ) : null}
      </span>
    )
  }
  if (item.state === 'failed') {
    return (
      <StatusWord sign="trouble" className="shrink-0">
        {item.detail}
      </StatusWord>
    )
  }
  if (item.state === 'done' && item.action) {
    const action = item.action
    return (
      <span className="flex shrink-0 items-baseline gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{item.detail}</span>
        <Button variant="link" size="inline" onClick={action.onSelect}>
          {action.label}
        </Button>
      </span>
    )
  }
  if (item.state === 'done') {
    return (
      <StatusWord sign="done" className="shrink-0">
        {item.detail}
      </StatusWord>
    )
  }
  return <span className="shrink-0 text-muted-foreground text-sm tabular-nums">{item.detail}</span>
}
