import { FolderTile } from '@contentops/ui/components/folder-tile'
import type { MosaicLayout, MosaicTile } from '@contentops/ui/components/mosaic'
import { type ReactNode, useRef } from 'react'
import { useGridArrowFocus } from '@/lib/use-grid-arrow-focus'

export interface PromoFolder {
  key: string
  href: string
  /** «Instagram», «КП2 офис нейлон». */
  name: string
  /** «6 подборок · 1 680 файлов», «PRM-015 · 60 видео · 2,65 ГБ». */
  composition: string
  /** Третья строка: «последняя передача 18.09», «✓ передано GaranTTeam 18.09». */
  note?: ReactNode
  tiles: readonly MosaicTile[]
  /** Горизонтальные кадры YouTube — сеткой 2 × 2, где 16:9 почти заполняет ячейку. */
  layout?: MosaicLayout
}

interface PromoFolderGridProps {
  folders: readonly PromoFolder[]
  label: string
}

/**
 * Папки Промо — каналы и подборки (DESIGN §4.17) — в той же сетке, что и корень
 * Библиотеки: `minmax(200px, 1fr)`, промежуток 16, стрелки ходят по папкам. Подписи
 * переносятся, а не обрезаются: ID, объём и подрядчик подборки в строку папки не входят.
 */
export function PromoFolderGrid({ folders, label }: PromoFolderGridProps) {
  const gridRef = useRef<HTMLUListElement>(null)
  const onKeyDown = useGridArrowFocus(gridRef, '[data-folder-link]')
  return (
    <ul
      ref={gridRef}
      aria-label={label}
      onKeyDown={onKeyDown}
      className="-mx-2 grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
    >
      {folders.map((folder) => (
        <li key={folder.key} className="min-w-0">
          <FolderTile
            href={folder.href}
            name={folder.name}
            composition={folder.composition}
            note={folder.note}
            tiles={folder.tiles}
            layout={folder.layout}
            wrap
          />
        </li>
      ))}
    </ul>
  )
}
