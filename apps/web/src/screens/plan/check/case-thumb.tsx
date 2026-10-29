import type { ItemId, SurfaceKind } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { NewspaperIcon, SquarePlayIcon } from 'lucide-react'
import { itemCoverById } from '@/lib/item-cover'

/** Строка сверки 40 × 53, строка «не проверено» 30 × 40 (DESIGN §7.6). */
const SIZE = {
  row: 'h-13.25 w-10',
  mini: 'h-10 w-7.5',
} as const

interface CaseThumbProps {
  itemId: ItemId | null
  /** Что видел Hub у поста без плана: стена или фуп. */
  surface: SurfaceKind
  size?: keyof typeof SIZE
  /** Решённая строка: миниатюра на 70 % (DESIGN §4.11). */
  dimmed?: boolean
  className?: string
}

/**
 * Наша миниатюра в строке сверки. У поста без плана своего объекта нет — пунктирная рамка
 * того же размера со значком стены или фупа.
 */
export function CaseThumb({
  itemId,
  surface,
  size = 'row',
  dimmed = false,
  className,
}: CaseThumbProps) {
  if (!itemId) {
    const Icon = surface === 'fyp' ? SquarePlayIcon : NewspaperIcon
    return (
      <div
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md border border-input border-dashed',
          SIZE[size],
          className,
        )}
      >
        <Icon className="size-4 text-ink-3" />
      </div>
    )
  }
  return (
    <Thumb
      {...itemCoverById(itemId)}
      showCaptions={false}
      className={cn(
        'shrink-0 rounded-md transition-opacity duration-160',
        SIZE[size],
        dimmed && 'opacity-70',
        className,
      )}
    />
  )
}
