import { formatNumber, type ItemId } from '@contentops/contracts'
import { ItemContextMenu, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'
import { ToPpvRow } from './to-ppv-row'
import { type ToPpvRow as Row, toPpvRowHeight } from './to-ppv-rows'

type CustomRow = Extract<Row, { kind: 'custom' }>

interface ToPpvListProps {
  rows: readonly Row[]
  ppvHref: (id: ItemId) => string
  onOpen: (id: ItemId) => void
  /** `null` — смотрящий не правит: кнопок «Сделать PPV» нет. */
  onMakePpv: ((id: ItemId) => void) | null
  menuFor: (row: CustomRow) => ItemMenuModel
}

const SelectedSchema = z.string().nullable()
const isCustom = (row: Row) => row.kind === 'custom'
const keyOf = (row: Row) => row.key

/**
 * Кастомы группами «Ещё не в PPV» и «Уже в PPV» (DESIGN §4.2). Список виртуальный,
 * выбранная строка и место прокрутки живут в записи истории (§3.13); `Enter` открывает
 * кастом.
 */
export function ToPpvList({ rows, ppvHref, onOpen, onMakePpv, menuFor }: ToPpvListProps) {
  const scroll = useHistoryScroll('to-ppv:scroll')
  const [selected, setSelected] = useHistoryState('to-ppv:selected', SelectedSchema, () => null)
  const selectedKeys = useMemo(() => new Set(selected ? [selected] : []), [selected])
  const onSelectedKeysChange = useCallback(
    (next: Set<string>) => setSelected([...next].find((key) => key !== selected) ?? null),
    [selected, setSelected],
  )

  return (
    <VirtualList
      items={rows}
      getKey={keyOf}
      getItemHeight={toPpvRowHeight}
      isSelectable={isCustom}
      selectedKeys={selectedKeys}
      onSelectedKeysChange={onSelectedKeysChange}
      onOpen={(row) => {
        if (row.kind === 'custom') onOpen(row.entry.id)
      }}
      label="Кастомы"
      initialScrollOffset={scroll.initialOffset}
      onScrollOffsetChange={scroll.onScrollOffsetChange}
      className="-mx-2 px-2 pb-8"
      renderItem={(row, state) =>
        row.kind === 'group' ? (
          <div className="flex h-11 items-end px-2 pb-2">
            <h2 className="flex items-baseline gap-2 text-lg">
              {row.label}
              <span className="font-normal text-ink-3 text-sm tabular-nums">
                {formatNumber(row.count)}
              </span>
            </h2>
          </div>
        ) : (
          <ItemContextMenu menu={menuFor(row)}>
            <div>
              <ToPpvRow
                entry={row.entry}
                selected={state.selected}
                ppvHref={row.entry.ppv_made_as ? ppvHref(row.entry.ppv_made_as) : null}
                onMakePpv={onMakePpv ? () => onMakePpv(row.entry.id) : null}
              />
            </div>
          </ItemContextMenu>
        )
      }
    />
  )
}
