import type { CatalogEntry, Handoff, ItemId } from '@contentops/contracts'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'
import { useOpenCollection } from '../shared/promo-links'
import { HandoffRow } from './handoff-row'

interface HandoffListProps {
  handoffs: readonly Handoff[]
  /** Подборки из индекса каталога: название и канал для адреса. */
  collections: ReadonlyMap<ItemId, CatalogEntry>
}

const ROW_HEIGHT = 52
const SelectedSchema = z.string().nullable()
const keyOf = (handoff: Handoff) => handoff.id
const rowHeight = () => ROW_HEIGHT

/**
 * «Передачи» списком (DESIGN §4.17), новые сверху. Стрелки ходят по строкам, `Enter` и
 * нажатие открывают подборку с этой передачей в панели.
 */
export function HandoffList({ handoffs, collections }: HandoffListProps) {
  const openCollection = useOpenCollection()
  const scroll = useHistoryScroll('promo:handoffs:scroll')
  const [selected, setSelected] = useHistoryState(
    'promo:handoffs:selected',
    SelectedSchema,
    () => null,
  )
  const selectedKeys = useMemo(() => new Set(selected ? [selected] : []), [selected])
  const onSelectedKeysChange = useCallback(
    (next: Set<string>) => setSelected([...next].find((key) => key !== selected) ?? null),
    [selected, setSelected],
  )

  const open = (handoff: Handoff) => {
    const channel = collections.get(handoff.collection_id)?.channel
    if (channel) {
      openCollection(channel, handoff.collection_id, { show: 'handoff', id: handoff.id })
    }
  }

  return (
    <VirtualList
      items={handoffs}
      getKey={keyOf}
      getItemHeight={rowHeight}
      selectedKeys={selectedKeys}
      onSelectedKeysChange={onSelectedKeysChange}
      onOpen={open}
      label="Передачи"
      initialScrollOffset={scroll.initialOffset}
      onScrollOffsetChange={scroll.onScrollOffsetChange}
      className="-mx-2 px-2 pb-8"
      renderItem={(handoff, state) => (
        <HandoffRow
          handoff={handoff}
          title={collections.get(handoff.collection_id)?.title ?? null}
          selected={state.selected}
          onOpen={() => open(handoff)}
        />
      )}
    />
  )
}
