import type { PlanRow } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { FilmIcon } from 'lucide-react'
import { itemCoverById } from '@/lib/item-cover'
import { isDoneRow } from './plan-text'

const SIZE = {
  /** Строка дня: 30 × 40 (DESIGN §7.6). */
  row: 'w-7.5',
  /** Мини-строка недели: 28 × 37. */
  mini: 'w-7',
  /** Второй вид недели, одна страница за раз: 48 × 64. */
  large: 'w-12',
} as const

interface RowThumbProps {
  row: PlanRow
  size?: keyof typeof SIZE
  className?: string
}

/**
 * Миниатюра строки плана: обложка объекта 3:4, метка «v2», если есть новая версия;
 * у строки, ждущей монтаж, — пунктирная рамка. Сделанная строка бледнее (70 %).
 */
export function RowThumb({ row, size = 'row', className }: RowThumbProps) {
  if (!row.manifest) {
    return (
      <div
        aria-hidden
        className={cn(
          'flex aspect-[3/4] shrink-0 items-center justify-center rounded-md border border-input border-dashed text-ink-3',
          SIZE[size],
          className,
        )}
      >
        <FilmIcon className="size-3.5" />
      </div>
    )
  }
  const cover = itemCoverById(row.manifest.item_id)
  return (
    <div className={cn('relative shrink-0', SIZE[size], className)}>
      <Thumb
        seed={row.manifest.thumb.key}
        kind={cover.kind}
        family={cover.family}
        showCaptions={false}
        className={cn(
          'rounded-md transition-opacity duration-160',
          isDoneRow(row) || row.cancelled ? 'opacity-70' : undefined,
        )}
      />
      {row.has_newer_version ? (
        <span className="absolute -right-1.5 -bottom-1 rounded-sm bg-bar px-1 text-2xs text-scrim-foreground leading-3.5">
          v2
        </span>
      ) : null}
    </div>
  )
}
