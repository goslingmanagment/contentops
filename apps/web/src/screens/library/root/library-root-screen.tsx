import { formatNumber, type ItemId, plural } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { tileViewOf } from '@/app/search-params'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { ObjectSelectionBar } from '@/objects/object-selection-bar'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { useRememberedView } from '@/shell/field/use-remembered-view'
import { useCurrentModel } from '@/shell/model/model-context'
import type { LibraryRootView } from '../search'
import { FolderGrid } from './folder-grid'
import { FolderList } from './folder-list'
import { RecentStrip } from './recent-strip'
import { RootInfoPanel } from './root-info-panel'
import { RootSkeleton } from './root-skeleton'
import { useLibraryRootData } from './use-library-root-data'
import { useRootSelection } from './use-root-selection'

const routeApi = getRouteApi('/_shell/$model/library')

/** Вид корня (DESIGN §4.1): крупная плитка или список; «Плитки» и сортировки у корня нет. */
const ROOT_VIEWS: readonly ObjectTileView[] = ['large', 'row']

function objectsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['объект', 'объекта', 'объектов'])}`
}

/**
 * Корень Библиотеки `#/<модель>/library` (DESIGN §4.1): за 5 секунд увидеть, что есть у
 * модели. Восемь разделов и «Ещё не залито» папками с мозаикой, числом и составом,
 * ниже — «Недавние».
 */
export function LibraryRootScreen() {
  const model = useCurrentModel()
  const search = routeApi.useSearch()
  const navigate = useNavigate({ from: '/$model/library' })
  const data = useLibraryRootData(model)
  const panel = useInfoPanel('library-root')
  const remembered = useRememberedView('library-root', search.view)
  const rootView: LibraryRootView = remembered.view === 'list' ? 'list' : 'large'
  const tileView = tileViewOf(rootView)
  const selection = useRootSelection()
  const scroll = useHistoryScroll('library-root:scroll')
  const scrollRef = useRef<HTMLDivElement>(null)

  const folders = data.folders
  const selected = useMemo(
    () =>
      data.recentObjects
        .filter((object) => selection.selectedKeys.has(object.entry.id))
        .map((object) => object.entry),
    [data.recentObjects, selection.selectedKeys],
  )

  const index = data.index
  const hasData = index.data !== undefined
  const total = index.data?.items.length ?? 0
  const empty = hasData && total === 0

  useKeyboardShortcut({ code: 'Escape', enabled: selected.length > 0 }, selection.clear)

  // Возврат на корень восстанавливает прокрутку, как только папки нарисованы (§3.13).
  useLayoutEffect(() => {
    if (hasData && scroll.initialOffset && scrollRef.current) {
      scrollRef.current.scrollTop = scroll.initialOffset
    }
  }, [hasData, scroll.initialOffset])

  const changeView = (next: ObjectTileView) => {
    const view: LibraryRootView = next === 'row' ? 'list' : 'large'
    remembered.remember(view)
    void navigate({ search: (previous) => ({ ...previous, view }), replace: true })
  }
  const openObject = (id: ItemId) =>
    void navigate({ to: '/$model/i/$id', params: { model: model.code, id } })

  const menu: ItemMenuModel = {
    actions: [
      {
        id: 'deleted',
        label:
          data.deletedCount === null
            ? 'Удалённые объекты'
            : `Удалённые объекты · ${formatNumber(data.deletedCount)}`,
        onSelect: () =>
          void navigate({ to: '/$model/library/deleted', params: { model: model.code } }),
      },
    ],
  }

  return (
    <FieldLayout
      aside={
        panel.open ? (
          <RootInfoPanel
            model={model}
            selected={selected}
            total={total}
            folders={folders ?? []}
            notUploaded={data.notUploaded}
            hubLine={data.hubLine}
            summaries={data.summaries.data}
            tags={data.tags}
            collections={data.collections}
            width={panel.width}
            onClose={panel.close}
          />
        ) : null
      }
    >
      <FieldHeader
        title="Библиотека"
        meta={hasData && !empty ? `${model.name} · ${objectsWord(total)}` : model.name}
        view={{ value: tileView, onChange: changeView, options: ROOT_VIEWS }}
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
      <RefreshStrip active={index.isFetching && hasData} />
      <div
        ref={scrollRef}
        onScroll={(event) => scroll.onScrollOffsetChange(event.currentTarget.scrollTop)}
        className="-mx-7 min-h-0 flex-1 overflow-y-auto px-7 pt-3 pb-8"
      >
        <QueryErrorLine
          query={index}
          hasData={hasData}
          shownAt={index.data?.generatedAt}
          className="mb-3"
        />
        {index.isPending ? <RootSkeleton /> : null}
        {empty ? (
          <EmptyState
            action={{
              label: 'Открыть Приехало',
              onSelect: () => void navigate({ to: '/$model/inbox', params: { model: model.code } }),
            }}
          >
            Библиотека пустая. Всё, что модель зальёт на Я.Диск, появится в Приехало
          </EmptyState>
        ) : null}
        {folders && !empty ? (
          <div className="flex flex-col gap-7">
            {tileView === 'row' ? (
              <FolderList folders={folders} />
            ) : (
              <FolderGrid folders={folders} />
            )}
            {data.recentObjects.length > 0 ? (
              <RecentStrip
                objects={data.recentObjects}
                layout={tileView === 'row' ? 'list' : 'large'}
                accounts={model.accounts}
                summaries={data.summaries.data}
                selectedKeys={selection.selectedKeys}
                onSelectedKeysChange={selection.setSelectedKeys}
                onOpen={openObject}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </FieldLayout>
  )
}
