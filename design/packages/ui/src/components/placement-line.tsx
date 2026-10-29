import { cn } from 'cn'
import { Fragment } from 'react'
import type { StatusKind } from './status-sign'
import { StatusWord } from './status-word'

export interface PlacementEntry {
  /** Страница словами: «Fansly 1», «OF VIP». */
  page: string
  /** Знак, только если он что-то значит: ✓ с датой, ◆ «сверить», ▲. */
  sign?: StatusKind
  /** «07.08», «сверить», «отмечено 09.08», «не видели». */
  text: string
}

interface PlacementLineProps {
  entries: readonly PlacementEntry[]
  /** Страница, чей раздел открыт в панели. */
  activePage?: string
  /** Нажатие на страницу открывает «Где залито · <страница>». */
  onSelectPage?: (page: string) => void
  className?: string
}

/**
 * Строка «где залито» по пяти страницам (DESIGN §4.4): самое сильное слово каждой
 * страницы, через точку. При узкой ширине переносится на вторую строку.
 */
export function PlacementLine({
  entries,
  activePage,
  onSelectPage,
  className,
}: PlacementLineProps) {
  return (
    <ul
      data-slot="placement-line"
      aria-label="Где залито"
      className={cn('flex flex-wrap items-center gap-x-1 gap-y-1 text-sm', className)}
    >
      {entries.map((entry, index) => (
        <Fragment key={entry.page}>
          {index > 0 ? (
            <li aria-hidden className="text-ink-3">
              ·
            </li>
          ) : null}
          <li>
            <button
              type="button"
              aria-pressed={entry.page === activePage}
              onClick={() => onSelectPage?.(entry.page)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 transition-colors duration-120 hover:bg-accent aria-pressed:bg-primary-tint"
            >
              <span className="font-medium text-foreground">{entry.page}</span>
              <StatusWord sign={entry.sign}>{entry.text}</StatusWord>
            </button>
          </li>
        </Fragment>
      ))}
    </ul>
  )
}
