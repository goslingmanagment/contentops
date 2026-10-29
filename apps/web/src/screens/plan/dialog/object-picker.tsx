import {
  type Account,
  type CatalogEntry,
  type ItemId,
  type ItemType,
  type NormKind,
  type PageSummaryEntry,
  SURFACE_LABEL,
  type SurfaceKind,
} from '@contentops/contracts'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@contentops/ui/components/input-group'
import { Thumb } from '@contentops/ui/components/thumb'
import { SearchIcon } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { PageSummariesView } from '@/data/catalog'
import { useEntriesSearch } from '@/data/catalog-search'
import { itemCover } from '@/lib/item-cover'
import { lengthText } from '@/objects/item-facts'
import { allowedSurfaces, alreadyThere } from './rules'

const LIMIT = 40

const KIND_TYPES: Record<NormKind, readonly ItemType[]> = {
  fyp: ['fyp'],
  wall: ['set', 'life', 'ppv'],
  life_vault: ['life'],
  story: ['ppv', 'set', 'life'],
}

const PLANNABLE: readonly ItemType[] = ['ppv', 'fyp', 'custom', 'set', 'sexting', 'life', 'raw']

/** Выложить можно только готовое: сырьё ставится под монтаж, промо в план не идёт. */
const POSTABLE: readonly ItemType[] = PLANNABLE.filter((type) => type !== 'raw')

interface ObjectPickerProps {
  catalog: readonly CatalogEntry[]
  summaries: PageSummariesView | undefined
  /** Страница места нормы или «вне плана». */
  account: Account | undefined
  surface: SurfaceKind | undefined
  kind: NormKind | undefined
  /** «Вне плана»: из последних объектов этой страницы. */
  recentFirst: boolean
  onPick: (id: ItemId) => void
}

function bestViews(entries: readonly PageSummaryEntry[] | undefined): number {
  return (entries ?? []).reduce((best, entry) => Math.max(best, entry.views ?? 0), 0)
}

function lastOn(entries: readonly PageSummaryEntry[] | undefined, account: Account): string {
  return entries?.find((entry) => entry.account === account.code)?.last_on ?? ''
}

/**
 * Поиск объекта в окне, открытом с пустого места (DESIGN §4.13): без запроса —
 * подсказки «Не было на Fansly 2» подходящего типа, у фупов сверху те, что лучше зашли.
 * Индекс целиком в браузере, поэтому поиск без ожидания.
 */
export function ObjectPicker({
  catalog,
  summaries,
  account,
  surface,
  kind,
  recentFirst,
  onPick,
}: ObjectPickerProps) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  // «Вне плана» — только то, что выкладывают; сырьё находится поиском, но не в подсказках.
  const types = kind ? KIND_TYPES[kind] : recentFirst ? POSTABLE : PLANNABLE
  const searchable = useMemo(
    () =>
      catalog.filter(
        (entry) =>
          types.includes(entry.type) &&
          (!surface || !account || allowedSurfaces(entry.type, account.platform).includes(surface)),
      ),
    [catalog, types, surface, account],
  )
  const found = useEntriesSearch(searchable, deferred)
  const { heading, list } = useMemo(() => {
    const byItem = summaries?.byItem
    if (deferred.trim()) {
      return { heading: null, list: found }
    }
    const fits = searchable.filter((entry) => POSTABLE.includes(entry.type))
    if (account && recentFirst) {
      const recent = fits
        .filter((entry) => lastOn(byItem?.get(entry.id), account) !== '')
        .sort((left, right) =>
          lastOn(byItem?.get(right.id), account).localeCompare(
            lastOn(byItem?.get(left.id), account),
          ),
        )
      return { heading: `Недавно на ${account.label}`, list: recent }
    }
    if (account && surface) {
      const fresh = fits.filter(
        (entry) =>
          !alreadyThere(
            byItem?.get(entry.id)?.find((summary) => summary.account === account.code),
            surface,
          ),
      )
      const sorted =
        kind === 'fyp'
          ? [...fresh].sort(
              (left, right) => bestViews(byItem?.get(right.id)) - bestViews(byItem?.get(left.id)),
            )
          : [...fresh].sort((left, right) => right.arrived_on.localeCompare(left.arrived_on))
      return { heading: `Не было на ${account.label} · ${SURFACE_LABEL[surface]}`, list: sorted }
    }
    return {
      heading: 'Недавно приехало',
      list: [...fits].sort((left, right) => right.arrived_on.localeCompare(left.arrived_on)),
    }
  }, [searchable, found, summaries, surface, account, kind, recentFirst, deferred])

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="ппв 73, кружево…"
          aria-label="Найти объект"
        />
      </InputGroup>
      {heading ? <h3 className="text-ink-3 text-sm">{heading}</h3> : null}
      <ul className="-mx-2 flex flex-col">
        {list.slice(0, LIMIT).map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onPick(entry.id)}
              className="flex h-13.5 w-full items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent focus-visible:bg-accent"
            >
              <Thumb
                {...itemCover(entry)}
                showCaptions={false}
                className="w-7.5 shrink-0 rounded-md"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-base">{entry.title}</span>
                <span className="truncate text-ink-3 text-sm">
                  {entry.id} · {lengthText(entry)}
                </span>
              </span>
            </button>
          </li>
        ))}
        {list.length === 0 ? (
          <li className="px-2 py-3 text-muted-foreground text-sm">Ничего не нашлось</li>
        ) : null}
      </ul>
    </div>
  )
}
