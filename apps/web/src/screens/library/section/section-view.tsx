import { type CatalogEntry, formatNumber, ITEM_TYPE_INFO, type ItemId } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { FilterChipsRow } from '@contentops/ui/components/filter-chips'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { VirtualGrid } from '@contentops/ui/components/virtual-grid'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useCallback, useMemo } from 'react'
import { useHistoryScroll } from '@/lib/use-history-state'
import { ObjectSelectionBar } from '@/objects/object-selection-bar'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { useCurrentModel } from '@/shell/model/model-context'
import type { CatalogFilters } from '../search'
import { CatalogChips, useTagOptions } from '../shared/catalog-chips'
import { CLEARED_FILTERS, hasActiveFilters, pickFilters } from '../shared/catalog-filters'
import { gapOf, minColumnWidth, rowHeightOf } from '../shared/collection-layout'
import { CollectionSkeleton } from '../shared/collection-skeleton'
import { EntriesViewer, useEntryPreview } from '../shared/entries-viewer'
import { EntryContextMenu } from '../shared/entry-context-menu'
import { EntryTile } from '../shared/entry-tile'
import { useLibraryHref } from '../shared/library-hrefs'
import { useLibraryMenu } from '../shared/library-menu'
import { ObjectsInfoPanel } from '../shared/objects-info-panel'
import { useCollectionSelection } from '../shared/use-collection-selection'
import { useOpenObject } from '../shared/use-open-object'
import { useTileView } from '../shared/use-tile-view'
import { chipsOf, SECTION_CONFIG, type SectionType } from './section-config'
import { parseSort, sortOptions, sortValue } from './section-sort'
import { SectionSummary } from './section-summary'
import { useSectionData } from './use-section-data'

/** Параметры адреса раздела, которые читает экран; у Кастомов вид уже без «Заказов». */
export interface SectionSearch extends CatalogFilters {
  view?: 'large' | 'grid' | 'list'
  sort?: string
  /** Объект в просмотре поверх сетки. */
  preview?: ItemId
}

export interface SearchChangeOptions {
  /** Новая запись истории (открыть просмотр), иначе адрес меняется на месте. */
  push?: boolean
}

interface SectionViewProps {
  type: SectionType
  search: SectionSearch
  /** Меняет адрес на месте: вид, сортировка и фильтры не копятся в истории. */
  onSearchChange: (patch: Partial<SectionSearch>, options?: SearchChangeOptions) => void
  /** Вкладки за заголовком: «Все · Заказы · Переделка в PPV» у Кастомов. */
  nav?: ReactNode
}

const getKey = (entry: CatalogEntry) => entry.id

/**
 * Раздел-тип `#/<модель>/library/<тип>` (DESIGN §4.2): выбрать объект глазами и фильтром.
 * Чипы, сортировка и вид — в адресе, выделение и прокрутка — в записи истории. Сетка
 * виртуальная: 796 фупов листаются без подгрузок. `Space` открывает просмотр поверх
 * сетки: стрелки идут по соседям, «Назад» возвращает в сетку (§3.5).
 */
export function SectionView({ type, search, onSearchChange, nav }: SectionViewProps) {
  const model = useCurrentModel()
  const navigate = useNavigate()
  const rootHref = useLibraryHref()
  const config = SECTION_CONFIG[type]
  const title = ITEM_TYPE_INFO[type].folder
  const storageKey = `library:${type}`

  const { tileView, changeView } = useTileView(storageKey, search.view, (view) =>
    onSearchChange({ view }),
  )
  const panel = useInfoPanel(storageKey)
  const filters = useMemo(() => pickFilters(search), [search])
  const sort = useMemo(
    () => parseSort(search.sort, config.sorts, model.accounts),
    [search.sort, config.sorts, model.accounts],
  )
  const data = useSectionData(model, type, filters, sort)
  const selection = useCollectionSelection(`${storageKey}:selection`, data.visible, getKey)
  const { selected, selectedKeys, setSelectedKeys, toggle } = selection
  const scroll = useHistoryScroll(`${storageKey}:scroll`)
  const tagOptions = useTagOptions(data.all, data.tags)
  const menu = useLibraryMenu(data.visible.length, selection.selectAll)
  const open = useOpenObject()
  const changePreview = useCallback(
    (preview: ItemId | undefined, options: SearchChangeOptions) =>
      onSearchChange({ preview }, options),
    [onSearchChange],
  )
  const preview = useEntryPreview({ preview: search.preview, change: changePreview })

  const index = data.index
  const hasData = index.data !== undefined
  const filtered = hasActiveFilters(filters)
  const summaries = data.summaries.data

  const renderItem = useCallback(
    (entry: CatalogEntry, state: { selected: boolean }) => (
      <EntryTile
        entry={entry}
        view={tileView}
        accounts={model.accounts}
        summaries={summaries?.byItem.get(entry.id)}
        hint={data.hint}
        selected={state.selected}
        onToggle={toggle}
      />
    ),
    [tileView, model.accounts, summaries, data.hint, toggle],
  )

  const body = (() => {
    if (index.isPending) {
      return <CollectionSkeleton view={tileView} className="-mx-2 pt-3" />
    }
    if (!hasData) {
      return (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void index.refetch()} />
      )
    }
    if (data.all.length === 0) {
      return (
        <EmptyState
          action={{
            label: 'Открыть Приехало',
            onSelect: () => void navigate({ to: '/$model/inbox', params: { model: model.code } }),
          }}
        >
          {config.empty}
        </EmptyState>
      )
    }
    if (data.visible.length === 0) {
      return (
        <EmptyState action={{ label: 'Сбросить', onSelect: () => onSearchChange(CLEARED_FILTERS) }}>
          По этим фильтрам ничего
        </EmptyState>
      )
    }
    return (
      <EntryContextMenu
        entries={data.visible}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
      >
        <VirtualGrid
          items={data.visible}
          getKey={getKey}
          renderItem={renderItem}
          minColumnWidth={minColumnWidth(tileView)}
          getRowHeight={rowHeightOf(tileView)}
          gap={gapOf(tileView)}
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          onOpen={(entry) => open(entry.id)}
          onPreview={(entry) => preview.open(entry.id)}
          label={title}
          initialScrollOffset={scroll.initialOffset}
          onScrollOffsetChange={scroll.onScrollOffsetChange}
          className="-mx-7 min-h-0 flex-1 px-5 pt-3 pb-6"
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
            summary={
              <SectionSummary
                model={model}
                type={type}
                title={title}
                entries={data.all}
                summaries={summaries}
              />
            }
          />
        ) : null
      }
    >
      <FieldHeader
        crumbs={[{ label: 'Библиотека', href: rootHref }]}
        title={title}
        meta={
          hasData && filtered
            ? `${formatNumber(data.visible.length)} из ${formatNumber(data.all.length)}`
            : undefined
        }
        count={hasData && !filtered ? data.all.length : undefined}
        note={data.pageLine ? <IntegrationPhrase line={data.pageLine} withOwnerAction /> : null}
        nav={nav}
        sort={{
          value: sortValue(sort),
          options: sortOptions(config.sorts, model.accounts),
          onChange: (next) => onSearchChange({ sort: next === config.sorts[0] ? undefined : next }),
        }}
        view={{ value: tileView, onChange: changeView }}
        info={{ open: panel.open, onToggle: panel.toggle }}
        menu={menu}
        selectionBar={
          selected.length > 0 ? (
            <ObjectSelectionBar
              selected={selected}
              collections={data.collections}
              onClear={selection.clear}
            />
          ) : undefined
        }
      />
      <FilterChipsRow canReset={filtered} onReset={() => onSearchChange(CLEARED_FILTERS)}>
        <CatalogChips
          chips={chipsOf(type)}
          filters={filters}
          onChange={onSearchChange}
          accounts={model.accounts}
          tagOptions={tagOptions}
        />
      </FilterChipsRow>
      <RefreshStrip active={index.isFetching && hasData} />
      {hasData ? <QueryErrorLine query={index} shownAt={index.data?.generatedAt} /> : null}
      {body}
      {preview.current && hasData ? (
        <EntriesViewer
          entries={data.visible}
          current={preview.current}
          onCurrentChange={preview.move}
          onClose={preview.close}
          onOpen={(id) => open(id)}
        />
      ) : null}
    </FieldLayout>
  )
}
