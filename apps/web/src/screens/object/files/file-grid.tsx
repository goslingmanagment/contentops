import {
  type FileCellState,
  type FileGridTools,
  type GridKeyAction,
  FileGrid as SharedFileGrid,
} from '@contentops/ui/components/file-grid'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import type { ReactNode } from 'react'
import { useFileSelection } from './file-selection'
import { useFilesScrollRef } from './files-scroll'

export type { FileCellState, GridKeyAction }

interface FileGridProps<Item> {
  items: readonly Item[]
  getKey: (item: Item) => string
  renderItem: (item: Item, state: FileCellState) => ReactNode
  /** Ширина ячейки с полями плитки: фото 98 + 8, кадры 82 + 8 (DESIGN §7.6). */
  cellWidth: number
  /** Высота ряда для окон прокрутки больших сетов: фото 131 + подпись. */
  rowHeight?: number
  fixedColumns?: number
  gap?: number
  label: string
  onReorder?: (keys: string[]) => void
  onOpen?: (item: Item) => void
  onKeyAction?: GridKeyAction
  menuFor?: (item: Item) => ItemMenuModel | null
  className?: string
}

/** Пункт меню файла, когда порядок меняется: «Переместить на позицию…» (§8). */
function withMove(menu: ItemMenuModel | null, tools: FileGridTools): ItemMenuModel | null {
  if (!menu || !tools.moveToPosition) {
    return menu
  }
  return {
    ...menu,
    actions: [
      ...menu.actions,
      { id: 'move', label: 'Переместить на позицию…', onSelect: tools.moveToPosition },
    ],
  }
}

/**
 * Сетка файлов объекта (DESIGN §4.4) — общая `FileGrid` с выделением объекта и его
 * прокруткой: большие сеты рисуются окнами, порядок меняется и мышью, и с клавиатуры
 * (`Alt` + стрелки), и пунктом меню.
 */
export function FileGrid<Item>({ menuFor, rowHeight = 160, ...props }: FileGridProps<Item>) {
  const selection = useFileSelection()
  const scrollRef = useFilesScrollRef()
  return (
    <SharedFileGrid
      {...props}
      rowHeight={rowHeight}
      selection={{ keys: selection.keys, onKeysChange: selection.setKeys }}
      scrollRef={scrollRef}
      menuFor={menuFor ? (item, tools) => withMove(menuFor(item), tools) : undefined}
    />
  )
}
