import { type CollectionMember, formatLongDay, formatNumber } from '@contentops/contracts'
import { CollectionOption } from '@contentops/ui/components/collection-option'
import { toggleKey } from '@contentops/ui/lib/selection'
import { useCollectionNavigation } from '@contentops/ui/lib/use-collection-navigation'
import { useElementWidth } from '@contentops/ui/lib/use-element-width'
import { useCallback, useId, useMemo, useRef } from 'react'
import { useToday } from '@/data/api-session'
import { MEMBER_GRID, MemberTile } from '../shared/member-tile'
import { handedText, memberKey } from '../shared/promo-text'
import type { UnfiledDay } from './unfiled-days'

interface UnfiledGridProps {
  days: readonly UnfiledDay[]
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  onOpen: (member: CollectionMember) => void
  selectable: boolean
}

const { minColumnWidth: MIN_TILE_WIDTH, gap: GAP } = MEMBER_GRID['3:4']

/** Нажатие на заголовок дня выделяет весь день, повторное — снимает (DESIGN §3.3). */
function toggleDay(selected: ReadonlySet<string>, day: UnfiledDay): Set<string> {
  const keys = day.members.map(memberKey)
  const all = keys.every((key) => selected.has(key))
  const next = new Set(selected)
  for (const key of keys) {
    if (all) next.delete(key)
    else next.add(key)
  }
  return next
}

/**
 * «Без подборки» — материалы по дням (DESIGN §4.17). Одна клавиатура и выделение на все
 * дни: щелчок, `Shift`, `Ctrl`, стрелки. Дни — обычные блоки: их немного, а невидимые
 * не рисуются (`content-visibility`).
 */
export function UnfiledGrid({
  days,
  selectedKeys,
  onSelectedKeysChange,
  onOpen,
  selectable,
}: UnfiledGridProps) {
  const today = useToday()
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(listRef)
  const columns = Math.max(1, Math.floor((width + GAP) / (MIN_TILE_WIDTH + GAP)))
  const members = useMemo(() => days.flatMap((day) => day.members), [days])
  const keys = useMemo(() => members.map(memberKey), [members])

  const scrollToIndex = useCallback(
    (index: number) =>
      document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' }),
    [listId],
  )
  const navigation = useCollectionNavigation({
    keys,
    columns,
    selectedKeys,
    onSelectedKeysChange,
    scrollToIndex,
    onOpen: (index) => {
      const member = members[index]
      if (member) onOpen(member)
    },
  })

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Без подборки"
      aria-multiselectable
      aria-activedescendant={keys.length > 0 ? `${listId}-${navigation.focusIndex}` : undefined}
      tabIndex={0}
      onKeyDown={navigation.handleKeyDown}
      className="group/collection -mx-2 flex flex-col gap-3 px-2 outline-none"
    >
      {days.map((day) => (
        <div key={day.date} className="flex flex-col gap-1 [content-visibility:auto]">
          <button
            type="button"
            disabled={!selectable}
            onClick={() => onSelectedKeysChange(toggleDay(selectedKeys, day))}
            className="flex h-9 items-center gap-2 self-start rounded-md px-2 text-base transition-colors duration-120 enabled:hover:bg-accent disabled:cursor-default"
          >
            {formatLongDay(day.date)}
            <span className="text-ink-3 text-sm tabular-nums">
              {formatNumber(day.members.length)}
            </span>
          </button>
          <div
            className="grid"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: GAP }}
          >
            {day.members.map((member, offset) => {
              const index = day.start + offset
              const selected = selectedKeys.has(memberKey(member))
              return (
                <CollectionOption
                  key={memberKey(member)}
                  id={`${listId}-${index}`}
                  index={index}
                  selected={selected}
                  focused={index === navigation.focusIndex}
                  onItemClick={navigation.handleItemClick}
                  onItemDoubleClick={navigation.handleItemDoubleClick}
                >
                  <MemberTile
                    member={member}
                    selected={selected}
                    handed={handedText(member, null, today)}
                    onSelectedChange={
                      selectable
                        ? () => onSelectedKeysChange(toggleKey(selectedKeys, memberKey(member)))
                        : undefined
                    }
                  />
                </CollectionOption>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
