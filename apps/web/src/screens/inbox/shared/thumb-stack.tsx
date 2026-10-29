import type { MosaicTile } from '@contentops/ui/components/mosaic'
import { Thumb } from '@contentops/ui/components/thumb'
import { FileArchiveIcon } from 'lucide-react'

/** Сдвиг и уменьшение карточек стопки: задние выглядывают справа. */
const LAYERS = [
  { left: 0, scale: 1 },
  { left: 10, scale: 0.9 },
  { left: 19, scale: 0.8 },
] as const

/**
 * Стопка из трёх миниатюр 48 × 64 (DESIGN §7.6, строка «Приехало»): первая целиком,
 * две следующие выглядывают из-за неё. Пустых карточек нет — сколько файлов, столько слоёв;
 * у архива без оглавления — значок архива.
 */
export function ThumbStack({ tiles }: { tiles: readonly MosaicTile[] }) {
  return (
    <span aria-hidden className="relative block h-16 w-17 shrink-0">
      {tiles.slice(0, LAYERS.length).map((tile, index) => {
        const layer = LAYERS[index] ?? LAYERS[0]
        return (
          <span
            key={tile.seed}
            className="absolute top-0 w-12 origin-left overflow-hidden rounded-md shadow-xs ring-1 ring-background"
            style={{
              left: layer.left,
              zIndex: LAYERS.length - index,
              transform: `scale(${layer.scale})`,
              top: `${((1 - layer.scale) * 64) / 2}px`,
            }}
          >
            <Thumb
              seed={tile.seed}
              kind={tile.kind}
              showCaptions={false}
              className="rounded-none"
            />
          </span>
        )
      })}
      {tiles.length === 0 ? (
        <span className="absolute inset-y-0 left-0 flex w-12 items-center justify-center rounded-md bg-muted text-ink-3">
          <FileArchiveIcon className="size-5" strokeWidth={1.5} />
        </span>
      ) : null}
    </span>
  )
}
