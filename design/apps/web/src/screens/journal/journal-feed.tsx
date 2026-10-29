import {
  addDays,
  formatDayMonthWords,
  formatLongDay,
  type Instant,
  type JournalEvent,
  type LocalDate,
  type ModelCode,
  mskDate,
} from '@contentops/contracts'
import { EventDayHeader, EventRowSkeleton } from '@contentops/ui/components/event-row'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { type KeyboardEvent, useEffect, useMemo } from 'react'
import { JournalEventDetails, JournalEventRow } from './journal-event'
import {
  buildJournalRows,
  isEventRow,
  type JournalRow,
  journalRowHeight,
  journalRowKey,
} from './journal-rows'
import type { JournalContext } from './use-journal-context'

interface JournalFeedProps {
  events: readonly JournalEvent[]
  model: ModelCode
  now: Instant
  hasMore: boolean
  loadMore: () => void
  context: JournalContext
  menuOf: (event: JournalEvent) => ItemMenuModel
}

/** «Сегодня, 22 сентября», «Вчера, 21 сентября», «Воскресенье, 20 сентября». */
function dayLabel(date: LocalDate, now: Instant): string {
  const today = mskDate(now)
  if (date === today) {
    return `Сегодня, ${formatDayMonthWords(date)}`
  }
  if (date === addDays(today, -1)) {
    return `Вчера, ${formatDayMonthWords(date)}`
  }
  return formatLongDay(date)
}

/** Строка «ещё»: появилась в кадре — подгружаем следующую страницу по курсору. */
function MoreRow({ loadMore }: { loadMore: () => void }) {
  useEffect(() => loadMore(), [loadMore])
  return <EventRowSkeleton />
}

/**
 * Лента журнала по дням (DESIGN §4.18): виртуальный список строк 48, стрелки ходят по
 * событиям, `Enter` и нажатие раскрывают «было → стало».
 */
export function JournalFeed({
  events,
  model,
  now,
  hasMore,
  loadMore,
  context,
  menuOf,
}: JournalFeedProps) {
  const { expanded, toggle, selectedKeys, setSelectedKeys } = context
  const rows = useMemo(
    () => buildJournalRows(events, expanded, hasMore),
    [events, expanded, hasMore],
  )

  const toggleSelected = (keyboard: KeyboardEvent) => {
    if (keyboard.code !== 'Enter' || keyboard.defaultPrevented) {
      return
    }
    const [current] = selectedKeys
    if (current && events.some((event) => event.id === current)) {
      keyboard.preventDefault()
      toggle(current)
    }
  }

  const renderRow = (row: JournalRow, state: { selected: boolean }) => {
    switch (row.kind) {
      case 'day':
        return <EventDayHeader>{dayLabel(row.date, now)}</EventDayHeader>
      case 'event':
        return (
          <JournalEventRow
            event={row.event}
            model={model}
            expanded={row.expanded}
            selected={state.selected}
            onToggle={() => toggle(row.event.id)}
            menu={menuOf(row.event)}
          />
        )
      case 'details':
        return <JournalEventDetails event={row.event} />
      case 'more':
        return <MoreRow loadMore={loadMore} />
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Enter слушается у списка внутри, здесь только всплытие
    <div className="min-h-0 flex-1" onKeyDown={toggleSelected}>
      <VirtualList
        items={rows}
        getKey={journalRowKey}
        getItemHeight={journalRowHeight}
        isSelectable={isEventRow}
        renderItem={renderRow}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
        label="События журнала"
        initialScrollOffset={context.initialScrollOffset}
        onScrollOffsetChange={context.onScrollOffsetChange}
        className="-mx-2 px-2 pb-8"
      />
    </div>
  )
}
