import {
  type CatalogEntry,
  formatNumber,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  ItemTypeSchema,
  mskDate,
} from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { FilterChipsRow, FilterSelectChip } from '@contentops/ui/components/filter-chips'
import {
  GroupedVirtualGrid,
  type GroupHeaderState,
} from '@contentops/ui/components/grouped-virtual-grid'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useCallback, useMemo } from 'react'
import type { z } from 'zod'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'
import { ObjectSelectionBar } from '@/objects/object-selection-bar'
import { FieldLayout } from '@/shell/field/field-layout'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { useCurrentModel } from '@/shell/model/model-context'
import { useGoTo } from '@/shell/navigation/use-go-to'
import { namedDestinationOf } from '@/shell/search/search-suggestions'
import { CatalogFiltersSchema } from '../library/search'
import { CatalogChips, useTagOptions } from '../library/shared/catalog-chips'
import {
  CLEARED_FILTERS,
  filterEntries,
  hasActiveFilters,
  whereConditions,
} from '../library/shared/catalog-filters'
import { gapOf, minColumnWidth, rowHeightOf } from '../library/shared/collection-layout'
import { CollectionSkeleton } from '../library/shared/collection-skeleton'
import { EntryContextMenu } from '../library/shared/entry-context-menu'
import { EntryTile } from '../library/shared/entry-tile'
import { ObjectsInfoPanel } from '../library/shared/objects-info-panel'
import type { TileHint } from '../library/shared/tile-hint'
import { useCollectionSelection } from '../library/shared/use-collection-selection'
import { useOpenObject } from '../library/shared/use-open-object'
import { SearchExtras, searchExtrasHeight } from './search-extras'
import { SearchGroupHeader } from './search-group-header'
import { type SearchGroup, searchGroups } from './search-groups'
import { useSearchData } from './use-search-data'

/** Чипы результата живут в записи истории вместе с запросом: в адрес запрос не пишется. */
const SearchFiltersSchema = CatalogFiltersSchema.extend({ type: ItemTypeSchema.optional() })
type SearchFilters = z.infer<typeof SearchFiltersSchema>

const TYPE_OPTIONS = ITEM_TYPES.map((type) => ({ value: type, label: ITEM_TYPE_INFO[type].folder }))
const HEADER_HEIGHT = 52
const getKey = (entry: CatalogEntry) => entry.id

/**
 * Страница результатов `/<модель>/search` (DESIGN §4.7): разбор ID, старый номер,
 * группы по типам по ряду из пяти, хронология и черновики «Приехало». Выделение, панель
 * и полоса — как в разделе Библиотеки.
 */
export function SearchResults({ query }: { query: string }) {
  const model = useCurrentModel()
  const href = useHref()
  const open = useOpenObject()
  const [filters, setFilters] = useHistoryState('search:filters', SearchFiltersSchema, () => ({}))
  const panel = useInfoPanel('search')
  const data = useSearchData(model, query)
  const scroll = useHistoryScroll('search:scroll')
  const today = mskDate(useClock().now())
  const summaries = data.summaries.data

  const change = useCallback(
    (patch: Partial<SearchFilters>) => setFilters((current) => ({ ...current, ...patch })),
    [setFilters],
  )
  const filter = useCallback(
    (entries: readonly CatalogEntry[]) => filterEntries(entries, filters, { summaries, today }),
    [filters, summaries, today],
  )
  const groups = useMemo(
    () => searchGroups(data.found, { filter, type: filters.type, oldNumber: data.oldNumber }),
    [data.found, data.oldNumber, filter, filters.type],
  )
  const visible = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const tagOptions = useTagOptions(data.found, data.tags)
  const hint = useMemo<TileHint | null>(() => {
    const [condition] = whereConditions(filters)
    const account = model.accounts.find((candidate) => candidate.code === condition?.account)
    return account ? { kind: 'page', account, today } : null
  }, [filters, model.accounts, today])

  const { selected, selectedKeys, setSelectedKeys, clear, toggle } = useCollectionSelection(
    'search:selection',
    visible,
    getKey,
  )
  const renderItem = useCallback(
    (entry: CatalogEntry, state: { selected: boolean }) => (
      <EntryTile
        entry={entry}
        view="large"
        accounts={model.accounts}
        summaries={summaries?.byItem.get(entry.id)}
        hint={hint}
        selected={state.selected}
        onToggle={toggle}
      />
    ),
    [model.accounts, summaries, hint, toggle],
  )
  const oldNumber = data.oldNumber?.number ?? null
  const renderHeader = useCallback(
    (group: SearchGroup, state: GroupHeaderState) => (
      <SearchGroupHeader
        group={group}
        state={state}
        oldNumber={oldNumber}
        onMore={() => change({ type: group.kind === 'old-number' ? undefined : group.kind })}
      />
    ),
    [oldNumber, change],
  )

  const serverPending = data.server.isPending && query.length > 0
  const extras = {
    timeline: data.timeline,
    drafts: data.drafts,
    pending: serverPending,
    byId: data.byId,
  }
  const extrasHeight = searchExtrasHeight(extras)
  const filtered = hasActiveFilters(filters)

  const body = (() => {
    if (!query) {
      return <EmptyState>Наберите в строке сверху номер, название или слова чаттера</EmptyState>
    }
    if (data.index.isPending) {
      return <CollectionSkeleton view="large" className="-mx-2 pt-4" />
    }
    if (!data.index.data) {
      return (
        <ErrorLine
          layout="center"
          message="Не загрузилось"
          onRetry={() => void data.index.refetch()}
        />
      )
    }
    if (groups.length === 0 && serverPending) {
      return <CollectionSkeleton view="large" className="-mx-2 pt-4" />
    }
    if (groups.length === 0 && extrasHeight === 0) {
      return filtered ? (
        <EmptyState action={{ label: 'Сбросить', onSelect: () => change(CLEARED_SEARCH) }}>
          По этим фильтрам ничего
        </EmptyState>
      ) : (
        <NothingFound query={query} modelName={model.name} />
      )
    }
    return (
      <EntryContextMenu
        entries={visible}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
      >
        <GroupedVirtualGrid
          groups={groups}
          getKey={getKey}
          renderItem={renderItem}
          renderHeader={renderHeader}
          headerHeight={HEADER_HEIGHT}
          footer={extrasHeight > 0 ? <SearchExtras {...extras} /> : undefined}
          footerHeight={extrasHeight}
          minColumnWidth={minColumnWidth('large')}
          getRowHeight={rowHeightOf('large')}
          gap={gapOf('large')}
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          onOpen={(entry) => open(entry.id)}
          label={`Найдено по «${query}»`}
          initialScrollOffset={scroll.initialOffset}
          onScrollOffsetChange={scroll.onScrollOffsetChange}
          className="-mx-7 min-h-0 flex-1 px-5 pb-6"
        />
      </EntryContextMenu>
    )
  })()

  return (
    <FieldLayout
      aside={
        panel.open ? (
          <ObjectsInfoPanel
            selected={selected}
            summaries={summaries}
            tags={data.tags}
            collections={data.collections}
            width={panel.width}
            onClose={panel.close}
            summary={<FoundSummary groups={groups} />}
          />
        ) : null
      }
    >
      <FieldHeader
        title={query ? `Поиск: ${query}` : 'Поиск'}
        info={{ open: panel.open, onToggle: panel.toggle }}
        selectionBar={
          selected.length > 0 ? (
            <ObjectSelectionBar
              selected={selected}
              collections={data.collections}
              onClear={clear}
            />
          ) : undefined
        }
      />
      <FilterChipsRow canReset={filtered} onReset={() => change(CLEARED_SEARCH)}>
        <FilterSelectChip
          label="Тип"
          options={TYPE_OPTIONS}
          selected={filters.type ? [filters.type] : []}
          activeLabel={(summary) => summary}
          onSelectedChange={([next]) => change({ type: ItemTypeSchema.safeParse(next).data })}
        />
        <CatalogChips
          chips={['where', 'tags', 'markup', 'period']}
          filters={filters}
          onChange={change}
          accounts={model.accounts}
          tagOptions={tagOptions}
        />
      </FilterChipsRow>
      {data.parsedId ? (
        <p className="mt-3 text-ink-3 text-sm">
          {query} →{' '}
          <UiLink
            href={href({ to: '/$model/i/$id', params: { model: model.code, id: data.parsedId } })}
            className="text-primary-ink hover:underline"
          >
            {data.parsedId}
          </UiLink>
        </p>
      ) : null}
      {data.server.isError && data.index.data ? (
        <ErrorLine
          className="mt-3"
          message="Описания и хронология не ответили"
          onRetry={() => void data.server.refetch()}
        />
      ) : null}
      {body}
    </FieldLayout>
  )
}

const CLEARED_SEARCH: Partial<SearchFilters> = { ...CLEARED_FILTERS, type: undefined }

/** «Ничего»; если запрос — имя раздела («план», «заказы»), вместо совета — переход туда. */
function NothingFound({ query, modelName }: { query: string; modelName: string }) {
  const model = useCurrentModel().code
  const { goToDestination } = useGoTo()
  const named = namedDestinationOf(query)
  return named ? (
    <EmptyState
      action={{
        label: `Открыть ${named.label}`,
        onSelect: () => goToDestination(model, named.destination),
      }}
    >
      {`По «${query}» объектов нет — это раздел`}
    </EmptyState>
  ) : (
    <EmptyState>{`По «${query}» ничего. Проверьте, та ли модель — сейчас ${modelName}`}</EmptyState>
  )
}

/** Панель без выделения: сколько найдено по типам. */
function FoundSummary({ groups }: { groups: readonly SearchGroup[] }) {
  const typed = groups.flatMap((group) =>
    group.kind === 'old-number'
      ? []
      : [{ label: ITEM_TYPE_INFO[group.kind].folder, total: group.total }],
  )
  const total = typed.reduce((sum, group) => sum + group.total, 0)
  return (
    <InfoSection
      title="Найдено"
      aside={<span className="text-ink-3 tabular-nums">{formatNumber(total)}</span>}
    >
      <p>{typed.map((group) => `${group.label} ${formatNumber(group.total)}`).join(' · ')}</p>
    </InfoSection>
  )
}
