import { formatNumber } from '@contentops/contracts/format'
import { cn } from 'cn'
import { type ReactNode, useId } from 'react'
import { Mosaic, type MosaicLayout, type MosaicTile } from './mosaic'
import { UiLink } from './ui-link'

export interface FolderTileProps {
  /** Адрес раздела: `#/lora/library/ppv`. */
  href: string
  /** «PPV», «Кастомы», «Ещё не залито». */
  name: string
  /** Серое число рядом с названием. */
  count?: number
  /** Строка состава: «52 бандла · 38 в личку · 11 ч». */
  composition: string
  /** Третья строка, место под неё отведено всегда: «+3 за неделю» или знак с делом. */
  note?: ReactNode
  /** Своя ссылка третьей строки: «▲ 1 заказ просрочен» открывает заказы, а не папку. */
  noteHref?: string
  tiles: readonly MosaicTile[]
  layout?: MosaicLayout
  /**
   * Состав и третья строка переносятся, а не обрезаются: у подборки Промо (§4.17) в них
   * ID, объём и подрядчик, в строку папки они не входят. Ряд выравнивается сеткой.
   */
  wrap?: boolean
  className?: string
}

/**
 * Папка раздела (DESIGN §4.1): язычок над мозаикой, рамка `--folder`, радиус 14, под ней
 * три строки. Наведение — подложка `--accent`, плитка не двигается. Ссылка папки
 * растянута на всю плитку; у третьей строки может быть своя ссылка поверх неё.
 */
export function FolderTile({
  href,
  name,
  count,
  composition,
  note,
  noteHref,
  tiles,
  layout,
  wrap = false,
  className,
}: FolderTileProps) {
  const compositionId = useId()
  return (
    <div
      data-slot="folder-tile"
      className={cn(
        'group relative flex min-w-0 flex-col gap-2.5 rounded-2xl p-2 pb-1.5 text-center transition-colors duration-120 hover:bg-accent has-[[data-folder-link]:focus-visible]:outline-2 has-[[data-folder-link]:focus-visible]:outline-ring has-[[data-folder-link]:focus-visible]:outline-offset-2',
        className,
      )}
    >
      <div className="relative pt-2.5">
        <FolderTab className="absolute top-0 left-3 h-2.5 w-16" />
        <div className="relative rounded-2xl bg-folder p-1.5">
          <Mosaic tiles={tiles} layout={layout} className="rounded-lg" />
        </div>
      </div>
      <div className="flex min-w-0 flex-col px-1">
        <p className="truncate">
          <UiLink
            href={href}
            data-folder-link=""
            aria-describedby={compositionId}
            className="outline-none after:absolute after:inset-0 after:rounded-2xl"
          >
            <span className="text-lg">{name}</span>
            {count === undefined ? null : (
              <span className="ml-1.5 text-ink-3 text-sm tabular-nums">{formatNumber(count)}</span>
            )}
          </UiLink>
        </p>
        <p
          id={compositionId}
          className={cn('text-muted-foreground text-sm', wrap ? 'text-balance' : 'truncate')}
        >
          {composition}
        </p>
        <div
          className={cn(
            'flex items-center justify-center text-ink-3 text-sm',
            wrap ? 'min-h-4.5' : 'h-4.5',
          )}
        >
          {noteHref && note ? (
            <UiLink
              href={noteHref}
              className="relative z-10 rounded-sm underline-offset-4 hover:underline"
            >
              {note}
            </UiLink>
          ) : (
            note
          )}
        </div>
      </div>
    </div>
  )
}

/** Язычок папки 64 × 10 со скошенным правым краем; им же помечены плитки групп «Приехало». */
export function FolderTab({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 10"
      preserveAspectRatio="none"
      aria-hidden
      className={cn('fill-folder-tab', className)}
    >
      <path d="M0 10V5C0 2.2 2.2 0 5 0H50.5C52.3 0 53.9 1 54.8 2.5L59 10Z" />
    </svg>
  )
}
