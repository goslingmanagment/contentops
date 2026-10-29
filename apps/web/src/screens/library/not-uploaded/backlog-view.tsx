import {
  type Account,
  type CatalogEntry,
  formatClock,
  formatNumber,
  mskDate,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { FilterChipsRow } from '@contentops/ui/components/filter-chips'
import {
  GroupedVirtualGrid,
  type GroupHeaderState,
} from '@contentops/ui/components/grouped-virtual-grid'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { useCallback, useMemo } from 'react'
import { useClock } from '@/data/api-session'
import { useHistoryScroll } from '@/lib/use-history-state'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { useCurrentModel } from '@/shell/model/model-context'
import type { CatalogFilters } from '../search'
import { type CatalogChipKey, CatalogChips, useTagOptions } from '../shared/catalog-chips'
import {
  CLEARED_FILTERS,
  filterEntries,
  hasActiveFilters,
  pickFilters,
} from '../shared/catalog-filters'
import { gapOf, minColumnWidth, rowHeightOf } from '../shared/collection-layout'
import { CollectionSkeleton } from '../shared/collection-skeleton'
import { EntryContextMenu } from '../shared/entry-context-menu'
import { EntryTile } from '../shared/entry-tile'
import { useLibraryHref } from '../shared/library-hrefs'
import { useLibraryMenu } from '../shared/library-menu'
import { ObjectsInfoPanel } from '../shared/objects-info-panel'
import { useCollectionSelection } from '../shared/use-collection-selection'
import { useOpenObject } from '../shared/use-open-object'
import { useTileView } from '../shared/use-tile-view'
import { type BacklogGroup, backlogGroups, backlogPlanPreset } from './backlog'
import { BacklogPanelActions, BacklogSelectionBar } from './backlog-selection-bar'
import { BacklogSummary } from './backlog-summary'
import { GroupHeader } from './group-header'
import { PageTabs } from './page-tabs'
import { useBacklogData } from './use-backlog-data'

/** Параметры адреса «Ещё не залито»: вкладка, вид, раскрытые группы и фильтры. */
export interface BacklogSearch extends CatalogFilters {
  page?: string
  view?: 'large' | 'grid' | 'list'
  fyp?: boolean
  planned?: boolean
}

interface BacklogViewProps {
  account: Account
  search: BacklogSearch
  /** Меняет адрес на месте: вкладка, вид и фильтры не копятся в истории. */
  onSearchChange: (patch: Partial<BacklogSearch>) => void
}

/** Чипы: «в личку» из сценария чаттера (§6.5) и общие, кроме «Где залито» — это вкладки. */
const CHIPS: readonly CatalogChipKey[] = ['kind', 'tags', 'markup', 'period']
const HEADER_HEIGHT = 52
const FOOTER_HEIGHT = 48
const STORAGE_KEY = 'library:not-uploaded'

const getKey = (entry: CatalogEntry) => entry.id

/**
 * «Ещё не залито» `#/<модель>/library/not-uploaded?page=lora-2` (DESIGN §4.3): ответить
 * «что ещё не залито на Fansly 2» и сразу поставить это в план. Вкладка — страница,
 * группы по типу, фупы свёрнуты, поставленное в план скрыто.
 */
export function BacklogView({ account, search, onSearchChange }: BacklogViewProps) {
  const model = useCurrentModel()
  const rootHref = useLibraryHref()
  const { tileView, changeView } = useTileView(STORAGE_KEY, search.view, (view) =>
    onSearchChange({ view }),
  )
  const panel = useInfoPanel(STORAGE_KEY)
  const filters = useMemo(() => pickFilters(search), [search])
  const filtered = hasActiveFilters(filters)
  const data = useBacklogData(model, account)
  const scroll = useHistoryScroll(`${STORAGE_KEY}:${account.code}:scroll`)
  const today = mskDate(useClock().now())
  const open = useOpenObject()

  const summaries = data.summaries.data
  const filter = useCallback(
    (entries: readonly CatalogEntry[]) => filterEntries(entries, filters, { summaries, today }),
    [filters, summaries, today],
  )
  const backlog = data.backlog
  const groups = useMemo<BacklogGroup[]>(
    () =>
      backlog
        ? backlogGroups(backlog, {
            filter,
            showFyp: search.fyp === true,
            showPlanned: search.planned === true,
          })
        : [],
    [backlog, filter, search.fyp, search.planned],
  )
  const everything = useMemo(() => (backlog ? [...backlog.byType.values()].flat() : []), [backlog])
  const tagOptions = useTagOptions(everything, data.tags)
  const visible = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const plannedHidden = backlog && !search.planned ? filter(backlog.planned).length : 0

  const selection = useCollectionSelection(
    `${STORAGE_KEY}:${account.code}:selection`,
    visible,
    getKey,
  )
  const { selected, selectedKeys, setSelectedKeys, clear, toggle } = selection
  const menu = useLibraryMenu(visible.length, selection.selectAll)

  const renderItem = useCallback(
    (entry: CatalogEntry, state: { selected: boolean }) => (
      <EntryTile
        entry={entry}
        view={tileView}
        accounts={model.accounts}
        summaries={summaries?.byItem.get(entry.id)}
        hint={null}
        page={account.code}
        selected={state.selected}
        onToggle={toggle}
      />
    ),
    [tileView, model.accounts, summaries, toggle, account.code],
  )
  const renderHeader = useCallback(
    (group: BacklogGroup, state: GroupHeaderState) => {
      const onToggle =
        group.kind === 'fyp'
          ? () => onSearchChange({ fyp: group.collapsed ? true : undefined })
          : group.kind === 'planned'
            ? () => onSearchChange({ planned: undefined })
            : undefined
      return <GroupHeader group={group} state={state} onToggle={onToggle} />
    },
    [onSearchChange],
  )

  const showPlanned = () => onSearchChange({ planned: true })
  const plannedLabel = `ещё ${formatNumber(plannedHidden)} уже в плане`
  const plannedLink =
    plannedHidden > 0 ? (
      <Button variant="link" onClick={showPlanned} className="text-ink-3 hover:text-foreground">
        {plannedLabel}
      </Button>
    ) : null

  const index = data.index
  const body = (() => {
    if (index.isPending || data.summaries.isPending || !data.linesSettled) {
      return <CollectionSkeleton view={tileView} className="-mx-2 pt-4" />
    }
    if (!backlog) {
      return (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void index.refetch()} />
      )
    }
    if (groups.length === 0 && everything.length === 0) {
      return (
        <EmptyState
          action={plannedHidden > 0 ? { label: plannedLabel, onSelect: showPlanned } : undefined}
        >
          {`Здесь пусто — на ${account.label} залито всё`}
        </EmptyState>
      )
    }
    if (groups.length === 0) {
      return (
        <EmptyState action={{ label: 'Сбросить', onSelect: () => onSearchChange(CLEARED_FILTERS) }}>
          По этим фильтрам ничего
        </EmptyState>
      )
    }
    return (
      <EntryContextMenu
        entries={visible}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
        planPreset={(entries) => backlogPlanPreset(account.code, entries, today)}
      >
        <GroupedVirtualGrid
          groups={groups}
          getKey={getKey}
          renderItem={renderItem}
          renderHeader={renderHeader}
          headerHeight={HEADER_HEIGHT}
          footer={
            plannedLink ? (
              <div className="flex h-full items-center px-2">{plannedLink}</div>
            ) : undefined
          }
          footerHeight={FOOTER_HEIGHT}
          minColumnWidth={minColumnWidth(tileView)}
          getRowHeight={rowHeightOf(tileView)}
          gap={gapOf(tileView)}
          selectedKeys={selectedKeys}
          onSelectedKeysChange={setSelectedKeys}
          onOpen={(entry) => open(entry.id)}
          label={`Ещё не залито на ${account.label}`}
          initialScrollOffset={scroll.initialOffset}
          onScrollOffsetChange={scroll.onScrollOffsetChange}
          className="-mx-7 min-h-0 flex-1 px-5 pb-6"
        />
      </EntryContextMenu>
    )
  })()

  const actionProps = { account, onMarked: clear, onShowFailed: setSelectedKeys }
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
              <BacklogSummary
                account={account}
                backlog={backlog}
                coverageNote={data.coverageNote}
              />
            }
            selectionActions={(entries) => (
              <BacklogPanelActions {...actionProps} selected={entries} />
            )}
          />
        ) : null
      }
    >
      <FieldHeader
        crumbs={[{ label: 'Библиотека', href: rootHref }]}
        title="Ещё не залито"
        view={{ value: tileView, onChange: changeView }}
        info={{ open: panel.open, onToggle: panel.toggle }}
        menu={menu}
        selectionBar={
          selected.length > 0 ? (
            <BacklogSelectionBar {...actionProps} selected={selected} onClear={clear} />
          ) : undefined
        }
      />
      <PageTabs
        tabs={data.tabs}
        value={account.code}
        onChange={(page) => onSearchChange({ page, planned: undefined })}
      />
      <FilterChipsRow
        canReset={filtered}
        onReset={() => onSearchChange(CLEARED_FILTERS)}
        className="mt-3"
        trailing={
          data.integration ? (
            <span className="flex min-w-0 items-center gap-2">
              <IntegrationPhrase line={data.integration} withOwnerAction />
              {data.asOf ? (
                <span className="shrink-0 text-ink-3 text-sm tabular-nums">
                  числа на {formatClock(data.asOf)}
                </span>
              ) : null}
            </span>
          ) : null
        }
      >
        <CatalogChips
          chips={CHIPS}
          filters={filters}
          onChange={onSearchChange}
          accounts={model.accounts}
          tagOptions={tagOptions}
        />
      </FilterChipsRow>
      {data.coverageNote ? (
        <p className="mt-3 truncate text-ink-3 text-sm">{data.coverageNote}</p>
      ) : null}
      <RefreshStrip active={index.isFetching && index.data !== undefined} />
      {index.data ? <QueryErrorLine query={index} shownAt={index.data.generatedAt} /> : null}
      {body}
    </FieldLayout>
  )
}
