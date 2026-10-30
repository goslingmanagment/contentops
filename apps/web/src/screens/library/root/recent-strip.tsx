import type { Account, CatalogEntry, ItemId, RecentItem } from '@contentops/contracts'
import { formatDate } from '@contentops/contracts'
import { CollectionOption } from '@contentops/ui/components/collection-option'
import { ObjectTile, type ObjectTileView } from '@contentops/ui/components/object-tile'
import { Tooltip, TooltipContent, TooltipTrigger } from '@contentops/ui/components/tooltip'
import { useCollectionNavigation } from '@contentops/ui/lib/use-collection-navigation'
import { useElementWidth } from '@contentops/ui/lib/use-element-width'
import { cn } from '@contentops/ui/lib/utils'
import { useCallback, useId, useMemo, useRef } from 'react'
import { useToday } from '@/data/api-session'
import type { PageSummariesView } from '@/data/catalog'
import { itemCover } from '@/lib/item-cover'
import { lengthText } from '@/objects/item-facts'
import { placedPagesText, tileSignOf } from '@/objects/placement-text'

export interface RecentObject {
  entry: CatalogEntry
  recent: RecentItem
}

/** Крупно — плитки 120 × 160, списком — строки 52. */
export type RecentLayout = 'large' | 'list'

interface RecentStripProps {
  objects: readonly RecentObject[]
  layout: RecentLayout
  accounts: readonly Account[]
  summaries: PageSummariesView | undefined
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  onOpen: (id: ItemId) => void
}

const TILE_MIN_WIDTH = 120
const GAP = 16

/**
 * «Недавние» (DESIGN §4.1): объекты, которых касались вы. Причина — в подсказке при
 * наведении, не на обложке. Выделение как в разделе: клик, `Shift`, `Ctrl`/`⌘`,
 * галочка при наведении, клик по заголовку — всё (§3.3); `Enter` и двойной клик
 * открывают объект.
 */
export function RecentStrip({
  objects,
  layout,
  accounts,
  summaries,
  selectedKeys,
  onSelectedKeysChange,
  onOpen,
}: RecentStripProps) {
  const today = useToday()
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const width = useElementWidth(listRef)
  const view: ObjectTileView = layout === 'list' ? 'row' : 'tile'
  const columns =
    layout === 'list' ? 1 : Math.max(1, Math.floor((width + GAP) / (TILE_MIN_WIDTH + GAP)))
  // «Недавние» — один ряд (DESIGN §4.1): сколько помещается по ширине, столько и видно.
  const visible = useMemo(
    () => (layout === 'list' || width === 0 ? objects : objects.slice(0, columns)),
    [objects, layout, width, columns],
  )
  const keys = useMemo(() => visible.map((object) => object.entry.id), [visible])
  const optionId = useCallback((index: number) => `${listId}-${index}`, [listId])

  const navigation = useCollectionNavigation({
    keys,
    columns,
    selectedKeys,
    onSelectedKeysChange,
    scrollToIndex: (index) =>
      document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' }),
    onOpen: (index) => {
      const key = keys[index]
      if (key) {
        onOpen(key)
      }
    },
  })

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selectedKeys)
    if (checked) {
      next.add(id)
    } else {
      next.delete(id)
    }
    onSelectedKeysChange(next)
  }

  return (
    <section aria-labelledby={`${listId}-title`} className="flex flex-col gap-2">
      <h2 id={`${listId}-title`} className="flex h-7 items-center">
        <button
          type="button"
          title="Выделить все"
          onClick={() => onSelectedKeysChange(new Set(keys))}
          className="-mx-1.5 rounded-md px-1.5 font-medium text-base transition-colors duration-120 hover:bg-accent"
        >
          Недавние
        </button>
      </h2>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Недавние"
        aria-multiselectable
        aria-activedescendant={visible.length > 0 ? optionId(navigation.focusIndex) : undefined}
        tabIndex={0}
        onKeyDown={navigation.handleKeyDown}
        className={cn(
          'group/collection -mx-2 outline-none',
          view === 'row' ? 'flex flex-col' : 'grid gap-4',
        )}
        style={
          view === 'row'
            ? undefined
            : { gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_WIDTH}px, 1fr))` }
        }
      >
        {visible.map(({ entry, recent }, index) => {
          const selected = selectedKeys.has(entry.id)
          const entrySummaries = summaries?.byItem.get(entry.id)
          const cover = itemCover(entry)
          return (
            <CollectionOption
              key={entry.id}
              id={optionId(index)}
              index={index}
              selected={selected}
              focused={index === navigation.focusIndex}
              onItemClick={navigation.handleItemClick}
              onItemDoubleClick={navigation.handleItemDoubleClick}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <ObjectTile
                      view={view}
                      id={entry.id}
                      title={entry.title}
                      kind={cover.kind}
                      coverFamily={cover.family}
                      coverSrc={cover.src}
                      durationSeconds={cover.durationSeconds}
                      countLabel={cover.countLabel}
                      versionCount={cover.versionCount}
                      sign={tileSignOf(entrySummaries, accounts)}
                      columns={[
                        lengthText(entry),
                        formatDate(entry.arrived_on, today),
                        placedPagesText(accounts, entrySummaries),
                      ]}
                      selected={selected}
                      onSelectedChange={(checked) => toggle(entry.id, checked)}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">{recent.reason}</TooltipContent>
              </Tooltip>
            </CollectionOption>
          )
        })}
      </div>
    </section>
  )
}
