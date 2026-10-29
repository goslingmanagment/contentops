import {
  type Account,
  type AccountCode,
  type CatalogEntry,
  formatNumber,
  type ItemType,
  SURFACE_LABEL,
  type SurfaceKind,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { SectionTabs } from '@contentops/ui/components/section-tabs'
import { Thumb } from '@contentops/ui/components/thumb'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { useDraggable } from '@dnd-kit/core'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PageSummariesView } from '@/data/catalog'
import { itemCover } from '@/lib/item-cover'
import { lengthText } from '@/objects/item-facts'
import { pagesLabel } from '../shared/plan-text'
import {
  DRAWER_TYPE_LABEL,
  drawerCandidates,
  drawerCountText,
  drawerSurface,
  drawerTypes,
} from './drawer-candidates'
import type { WeekDragData } from './week-dnd'

const TILE_HEIGHT = 52

export interface DrawerState {
  account: AccountCode
  type: ItemType
}

interface WeekDrawerProps {
  state: DrawerState
  onStateChange: (next: DrawerState) => void
  accounts: readonly Account[]
  catalog: readonly CatalogEntry[]
  summaries: PageSummariesView | undefined
  /** Страницы, где норма ждёт такое же место: «Разложить ▾ → Fansly 1, 2, 3». */
  samePlacePages: (account: AccountCode, type: ItemType) => readonly Account[]
  /** Место раскладки типа на этой странице: «стена», «vault». */
  placeOf: (type: ItemType, account: AccountCode) => SurfaceKind
  canAct: boolean
  onSpread: (entries: readonly CatalogEntry[], accounts: readonly AccountCode[]) => void
  onClose: () => void
}

/**
 * Ящик «Ещё не залито» (DESIGN §4.12): 300 поверх сетки справа, не сужает её. Незалитое
 * на выбранную страницу с чипом типа; плитку тащат на ячейку, несколько выделяют и
 * «Разложить».
 */
export function WeekDrawer({
  state,
  onStateChange,
  accounts,
  catalog,
  summaries,
  samePlacePages,
  placeOf,
  canAct,
  onSpread,
  onClose,
}: WeekDrawerProps) {
  const account = accounts.find((candidate) => candidate.code === state.account) ?? accounts[0]
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const candidates = useMemo(
    () => (account ? drawerCandidates(catalog, summaries, account, state.type) : []),
    [catalog, summaries, account, state.type],
  )
  // Поставленное уходит из ящика — значит, раскладка прошла: выделение снимается целиком.
  const placed = [...selected].some((id) => !candidates.some((entry) => entry.id === id))
  useEffect(() => {
    if (placed) {
      setSelected(new Set())
    }
  }, [placed])
  if (!account) {
    return null
  }
  const chosen = candidates.filter((entry) => selected.has(entry.id))
  const wider = samePlacePages(account.code, state.type)
  const change = (next: DrawerState) => {
    setSelected(new Set())
    onStateChange(next)
  }
  return (
    <aside
      aria-label="Ещё не залито"
      className="absolute inset-y-0 right-0 z-20 flex w-75 flex-col border-border border-l bg-background shadow-md duration-160 animate-in fade-in-0 slide-in-from-right-4"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate font-medium text-base">Ещё не залито</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Закрыть ящик" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <SectionTabs
        label="Страница"
        size="sm"
        value={account.code}
        onChange={(code) => {
          const next = accounts.find((candidate) => candidate.code === code)
          if (next) {
            const types = drawerTypes(next)
            change({
              account: next.code,
              type: types.includes(state.type) ? state.type : (types[0] ?? 'set'),
            })
          }
        }}
        tabs={accounts.map((candidate) => ({ value: candidate.code, label: candidate.label }))}
        className="flex-wrap px-3 pb-2"
      />
      <ChoiceChips
        label="Тип"
        value={state.type}
        onChange={(type) => change({ account: account.code, type })}
        choices={drawerTypes(account).map((type) => ({
          value: type,
          label: DRAWER_TYPE_LABEL[type] ?? type,
        }))}
        className="px-4 pb-3"
      />
      <div className="flex h-10 shrink-0 items-center gap-2 border-border border-t px-4">
        <span className="min-w-0 flex-1 text-ink-3 text-sm tabular-nums">
          {chosen.length > 0
            ? `Выбрано ${formatNumber(chosen.length)} из ${formatNumber(candidates.length)}`
            : drawerCountText(state.type, candidates.length)}
        </span>
        {canAct && chosen.length > 0 ? (
          <SpreadButton
            count={chosen.length}
            account={account}
            wider={wider}
            place={SURFACE_LABEL[placeOf(state.type, account.code)]}
            onSpread={(codes) => onSpread(chosen, codes)}
          />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 px-2">
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-muted-foreground text-sm">Всё уже на {account.label}</p>
        ) : (
          <VirtualList
            items={candidates}
            getKey={(entry) => entry.id}
            getItemHeight={() => TILE_HEIGHT}
            renderItem={(entry, item) => (
              <DrawerTile entry={entry} selected={item.selected} canDrag={canAct} />
            )}
            selectedKeys={selected}
            onSelectedKeysChange={setSelected}
            label={`Ещё не залито на ${account.label}`}
            className="pb-4"
          />
        )}
      </div>
    </aside>
  )
}

interface DrawerTileProps {
  entry: CatalogEntry
  selected: boolean
  canDrag: boolean
}

/** Плитка ящика 52: миниатюра, название, ID и длительность; тащится на ячейку недели. */
function DrawerTile({ entry, selected, canDrag }: DrawerTileProps) {
  const data: WeekDragData = { kind: 'item', entry, surface: drawerSurface(entry) }
  const drag = useDraggable({ id: `item:${entry.id}`, data, disabled: !canDrag })
  return (
    <div
      ref={drag.setNodeRef}
      {...drag.listeners}
      data-dragging={drag.isDragging}
      data-selected={selected}
      className="flex h-13 select-none items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[dragging=true]:opacity-40 data-[selected=true]:bg-primary-tint"
    >
      <Thumb {...itemCover(entry)} showCaptions={false} className="w-7.5 shrink-0 rounded-md" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm">{entry.title}</span>
        <span className="truncate text-ink-3 text-xs">
          {entry.id} · {lengthText(entry)}
        </span>
      </span>
    </div>
  )
}

interface SpreadButtonProps {
  count: number
  account: Account
  wider: readonly Account[]
  /** «стена», «фуп» — место, которое займут строки. */
  place: string
  onSpread: (accounts: readonly AccountCode[]) => void
}

/** «Разложить (7) ▾»: на эту страницу или на все страницы, где норма ждёт то же место. */
function SpreadButton({ count, account, wider, place, onSpread }: SpreadButtonProps) {
  return (
    <div className="inline-flex">
      <Button size="sm" className="rounded-r-none" onClick={() => onSpread([account.code])}>
        Разложить ({formatNumber(count)})
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-sm"
            aria-label="Куда разложить"
            className="w-7 rounded-l-none border-l border-l-primary-foreground/30"
          >
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onSelect={() => onSpread([account.code])}>
            Только {account.label}
          </DropdownMenuItem>
          {wider.length > 1 ? (
            <DropdownMenuItem onSelect={() => onSpread(wider.map((page) => page.code))}>
              {pagesLabel(wider)} · {place}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
