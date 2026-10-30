import type { CheckCase, LocalDate, UnverifiedRow } from '@contentops/contracts'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { hasModifierKey, isTypingTarget } from '@contentops/ui/lib/platform'
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useMemo } from 'react'
import { isOpenCase } from '@/data/check'
import { CaseGroupHeader } from './case-group-header'
import type { DecisionKey } from './case-kinds'
import { type QueueItem, queueItemHeight } from './queue-items'
import {
  ReasonRow,
  UnverifiedLine,
  UnverifiedRowSkeleton,
  UnverifiedRowView,
} from './unverified-items'

const DIGITS: Record<string, DecisionKey | undefined> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
}

/** Выбрать можно только случай, который ждёт человека; решённый сереет и пропускается. */
function isSelectableItem(item: QueueItem): boolean {
  return item.kind === 'case' && isOpenCase(item.entry)
}

/** Случаи массово не выделяются (§3.3): из набора остаётся один, последний нажатый. */
export function pickOne(next: ReadonlySet<string>, current: string | null): string | null {
  const keys = [...next]
  return keys.find((key) => key !== current) ?? keys[0] ?? null
}

export interface UnverifiedHandlers {
  toggle: () => void
  toggleReason: (reason: string) => void
  /** «OF Free»: строки разных страниц стоят в одной группе причины. */
  pageLabel: (account: UnverifiedRow['account']) => string
}

interface CaseQueueProps {
  items: readonly QueueItem[]
  today: LocalDate
  selectedId: string | null
  onSelect: (caseId: string | null) => void
  /** `Enter` и двойной щелчок — «Разобрать». */
  onOpen: (caseId: string) => void
  onDecisionKey: (key: DecisionKey) => void
  renderCase: (entry: CheckCase, selected: boolean) => ReactNode
  unverified: UnverifiedHandlers
  onResetFilter: () => void
  emptyText: string
  listRef: RefObject<HTMLDivElement | null>
  initialScrollOffset?: number
  onScrollOffsetChange: (offset: number) => void
}

/**
 * Очередь «Сверить» (DESIGN §4.15): список по страницам, как день плана, виртуальный и
 * с клавишами — стрелки, `Enter`, `1` «Это оно», `2` «Разобрать», `3` «Не то». Цифры
 * действуют, только когда фокус в списке (§3.12). Фокус идёт за выбранным случаем: после
 * решения — на следующий, по адресу случая — сразу к нему.
 */
export function CaseQueue({
  items,
  today,
  selectedId,
  onSelect,
  onOpen,
  onDecisionKey,
  renderCase,
  unverified,
  onResetFilter,
  emptyText,
  listRef,
  initialScrollOffset,
  onScrollOffsetChange,
}: CaseQueueProps) {
  const selectedKeys = useMemo(() => new Set<string>(selectedId ? [selectedId] : []), [selectedId])

  const handleKeyDown = (event: KeyboardEvent) => {
    const key = DIGITS[event.code]
    if (!key || event.altKey || hasModifierKey(event) || isTypingTarget(event.target)) {
      return
    }
    event.preventDefault()
    onDecisionKey(key)
  }

  const renderRow = useCallback(
    (item: QueueItem, state: { selected: boolean }): ReactNode => {
      switch (item.kind) {
        case 'group':
          return <CaseGroupHeader account={item.account} line={item.line} first={item.first} />
        case 'case':
          return renderCase(item.entry, state.selected)
        case 'unverified':
          return (
            <UnverifiedLine
              unverified={item.unverified}
              open={item.open}
              onToggle={unverified.toggle}
            />
          )
        case 'reason':
          return (
            <ReasonRow
              reason={item.reason}
              count={item.count}
              open={item.open}
              onToggle={() => unverified.toggleReason(item.reason)}
            />
          )
        case 'unverified-row':
          return <UnverifiedRowItem row={item.row} today={today} unverified={unverified} />
        case 'rows-pending':
          return <UnverifiedRowSkeleton />
        case 'empty':
          return (
            <EmptyState
              action={item.filtered ? { label: 'Сбросить', onSelect: onResetFilter } : undefined}
            >
              {item.filtered ? 'По этим фильтрам ничего' : emptyText}
            </EmptyState>
          )
      }
    },
    [emptyText, onResetFilter, renderCase, today, unverified],
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: цифры слушает список внутри, это лишь всплытие
    <div ref={listRef} onKeyDown={handleKeyDown} className="-mx-2 min-h-0 flex-1">
      <VirtualList
        items={items}
        getKey={(item) => item.key}
        getItemHeight={queueItemHeight}
        isSelectable={isSelectableItem}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={(next) => onSelect(pickOne(next, selectedId))}
        onOpen={(item) => (item.kind === 'case' ? onOpen(item.entry.id) : undefined)}
        renderItem={renderRow}
        label="Случаи сверки"
        initialScrollOffset={initialScrollOffset}
        onScrollOffsetChange={onScrollOffsetChange}
        focusKey={selectedId}
        className="px-2 pb-8"
      />
    </div>
  )
}

function UnverifiedRowItem({
  row,
  today,
  unverified,
}: {
  row: UnverifiedRow
  today: LocalDate
  unverified: UnverifiedHandlers
}) {
  return <UnverifiedRowView row={row} pageLabel={unverified.pageLabel(row.account)} today={today} />
}
