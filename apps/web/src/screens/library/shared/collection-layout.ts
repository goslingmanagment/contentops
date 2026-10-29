import { type ObjectTileView, objectTileHeight } from '@contentops/ui/components/object-tile'

/**
 * Размеры плиток раздела (DESIGN §4.2, §3.1): крупная — обложка ≈176 × 234, 5 в ряд без
 * панели и 3 с панелью и при 1440, и при 1280; плитка — ≈120 × 160, 8 в ряд; список —
 * строка 52.
 */
export const TILE_MIN_WIDTH: Record<Exclude<ObjectTileView, 'row'>, number> = {
  large: 184,
  tile: 120,
}

export function minColumnWidth(view: ObjectTileView): number {
  return view === 'row' ? Number.POSITIVE_INFINITY : TILE_MIN_WIDTH[view]
}

export function gapOf(view: ObjectTileView): number {
  return view === 'row' ? 0 : 16
}

export function rowHeightOf(view: ObjectTileView) {
  return (columnWidth: number) => objectTileHeight(view, columnWidth)
}
