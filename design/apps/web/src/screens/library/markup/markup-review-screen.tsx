import {
  type CatalogEntry,
  formatNumber,
  ITEM_TYPE_INFO,
  ITEM_TYPES,
  type ItemId,
  ItemTypeSchema,
  type MarkupReviewItem,
  type Tag,
} from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { FilterChipsRow, FilterSelectChip } from '@contentops/ui/components/filter-chips'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { EmptyState, ErrorLine } from '@contentops/ui/components/state-lines'
import { VirtualList } from '@contentops/ui/components/virtual-list'
import { useCallback, useMemo, useState } from 'react'
import { useCatalogIndex, useMarkupReview, usePageSummaries, useTags } from '@/data/catalog'
import { useIntegrations } from '@/data/integrations'
import { useHistoryScroll, useHistoryState } from '@/lib/use-history-state'
import { FieldLayout } from '@/shell/field/field-layout'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { IntegrationPhrase } from '@/shell/integration/integration-phrase'
import { useCurrentModel } from '@/shell/model/model-context'
import { useLibraryHref } from '../shared/library-hrefs'
import { useLibraryMenu } from '../shared/library-menu'
import { ObjectsInfoPanel } from '../shared/objects-info-panel'
import { useCollectionSelection } from '../shared/use-collection-selection'
import { useOpenObject } from '../shared/use-open-object'
import { FrameSheet } from './frame-sheet'
import { MARKUP_ROW_HEIGHT, MarkupRow } from './markup-row'
import { MarkupPanelActions, MarkupSelectionBar } from './markup-selection-bar'
import { type MarkupLine, markupRowValues } from './markup-values'

const TYPE_OPTIONS = ITEM_TYPES.filter((type) => type !== 'promo').map((type) => ({
  value: type,
  label: ITEM_TYPE_INFO[type].folder,
}))
const TypeStateSchema = ItemTypeSchema.nullable()
const STORAGE_KEY = 'library:markup'
const getKey = (line: MarkupLine) => line.entry.id

function linesOf(
  items: readonly MarkupReviewItem[] | undefined,
  byId: ReadonlyMap<ItemId, CatalogEntry> | undefined,
  tags: readonly Tag[] | undefined,
): MarkupLine[] {
  return (items ?? []).flatMap((item) => {
    const entry = byId?.get(item.item_id)
    return entry ? [{ entry, values: markupRowValues(item, tags) }] : []
  })
}

/**
 * «Разметка на проверку» `#/<модель>/library/markup` (DESIGN §4.20): появляется, когда
 * работает разметка ИИ. Строки показывают значения полей; «Подтвердить всю разметку · N»
 * подтверждает ровно те версии, что видны.
 */
export function MarkupReviewScreen() {
  const model = useCurrentModel()
  const rootHref = useLibraryHref()
  const review = useMarkupReview(model.code)
  const index = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  const tags = useTags().data
  const integrations = useIntegrations()
  const panel = useInfoPanel(STORAGE_KEY)
  const scroll = useHistoryScroll(`${STORAGE_KEY}:scroll`)
  const [type, setType] = useHistoryState(`${STORAGE_KEY}:type`, TypeStateSchema, () => null)

  const ai = integrations.data?.find((integration) => integration.kind === 'ai')
  const lines = useMemo(
    () =>
      linesOf(review.data, index.data?.byId, tags).filter(
        (line) => type === null || line.entry.type === type,
      ),
    [review.data, index.data, tags, type],
  )
  const collections = useMemo(
    () => (index.data?.items ?? []).filter((entry) => entry.type === 'promo'),
    [index.data],
  )

  const selection = useCollectionSelection(`${STORAGE_KEY}:selection`, lines, getKey)
  const { selected, selectedKeys, setSelectedKeys, clear, toggle } = selection
  const menu = useLibraryMenu(lines.length, selection.selectAll)
  const open = useOpenObject()
  const renderItem = useCallback(
    (line: MarkupLine, state: { selected: boolean }) => (
      <MarkupRow
        entry={line.entry}
        values={line.values}
        selected={state.selected}
        onToggle={toggle}
      />
    ),
    [toggle],
  )

  const [framesOf, setFramesOf] = useState<ItemId | null>(null)
  const actionProps = {
    lines: selected,
    onConfirmed: clear,
    onShowFailed: setSelectedKeys,
    onOpenFrames: setFramesOf,
  }
  const aiOff = ai !== undefined && ai.state !== 'working'
  const body = (() => {
    if (aiOff) {
      return (
        <div className="flex flex-1 items-center justify-center">
          <IntegrationPhrase line={ai.line} withOwnerAction />
        </div>
      )
    }
    if (review.isPending || index.isPending) {
      return (
        <div aria-busy className="flex flex-col pt-3">
          {Array.from({ length: 8 }, (_, row) => (
            <ListRowSkeleton key={row} height={MARKUP_ROW_HEIGHT} />
          ))}
        </div>
      )
    }
    if (review.isError || !index.data) {
      return (
        <ErrorLine layout="center" message="Не загрузилось" onRetry={() => void review.refetch()} />
      )
    }
    if (lines.length === 0) {
      return type === null ? (
        <EmptyState>Вся разметка подтверждена</EmptyState>
      ) : (
        <EmptyState action={{ label: 'Сбросить', onSelect: () => setType(null) }}>
          По этим фильтрам ничего
        </EmptyState>
      )
    }
    return (
      <VirtualList
        items={lines}
        getKey={getKey}
        renderItem={renderItem}
        getItemHeight={() => MARKUP_ROW_HEIGHT}
        selectedKeys={selectedKeys}
        onSelectedKeysChange={setSelectedKeys}
        onOpen={(line) => open(line.entry.id)}
        label="Разметка на проверку"
        initialScrollOffset={scroll.initialOffset}
        onScrollOffsetChange={scroll.onScrollOffsetChange}
        className="-mx-7 min-h-0 flex-1 px-5 pt-3 pb-6"
      />
    )
  })()

  return (
    <FieldLayout
      aside={
        panel.open ? (
          <ObjectsInfoPanel
            selected={selected.map((line) => line.entry)}
            summaries={summaries.data}
            tags={tags}
            collections={collections}
            width={panel.width}
            onClose={panel.close}
            summary={
              <InfoSection title="Ждут подтверждения">
                <p className="tabular-nums">{formatNumber(lines.length)}</p>
              </InfoSection>
            }
            selectionActions={() => <MarkupPanelActions {...actionProps} />}
          />
        ) : null
      }
    >
      <FieldHeader
        crumbs={[{ label: 'Библиотека', href: rootHref }]}
        title="Разметка на проверку"
        count={review.data && !aiOff ? lines.length : undefined}
        info={{ open: panel.open, onToggle: panel.toggle }}
        menu={menu}
        selectionBar={
          selected.length > 0 ? <MarkupSelectionBar {...actionProps} onClear={clear} /> : undefined
        }
      />
      <FilterChipsRow canReset={type !== null} onReset={() => setType(null)}>
        <FilterSelectChip
          label="Тип"
          options={TYPE_OPTIONS}
          selected={type ? [type] : []}
          activeLabel={(summary) => summary}
          onSelectedChange={([next]) => setType(ItemTypeSchema.safeParse(next).data ?? null)}
        />
      </FilterChipsRow>
      {body}
      {framesOf ? <FrameSheet id={framesOf} onClose={() => setFramesOf(null)} /> : null}
    </FieldLayout>
  )
}
