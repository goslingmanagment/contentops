import {
  ApiError,
  type CatalogEntry,
  type CollectionMember,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { FieldHeader, HeaderAction } from '@contentops/ui/components/field-header'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { PackageIcon } from 'lucide-react'
import { useCatalogIndex } from '@/data/catalog'
import { usePromoChannels, usePromoCollection } from '@/data/promo'
import { useRole } from '@/data/session'
import { useHistoryState } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { NotFoundState } from '@/screens/errors'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { useCurrentModel } from '@/shell/model/model-context'
import { HANDOFF_PANEL_KEY, HandoffPanelStateSchema } from '../handoff/handoff-panel-state'
import { usePromoCrumbs } from '../promo-crumbs'
import { usePromoMenu } from '../shared/promo-menu'

import { collectionContractor, mediaComposition, memberKey } from '../shared/promo-text'

import { useMemberSelection } from '../shared/use-member-selection'
import { usePromoActions } from '../shared/use-promo-actions'
import { CollectionAside } from './collection-aside'
import { CollectionSkeleton } from './collection-skeleton'
import { MemberGrid } from './member-grid'

const routeApi = getRouteApi('/_shell/$model/library/promo/$channel/$collection')

const NO_CATALOG: ReadonlyMap<ItemId, CatalogEntry> = new Map()

/**
 * Подборка промо `/<модель>/library/promo/<канал>/<PRM>` (DESIGN §4.17): сетка файлов,
 * «Подготовить передачу» — правая панель 400 в два шага, для всей подборки из шапки или
 * для выбранного из полосы выделения; «ⓘ» — карточка материала.
 */
export function PromoCollectionScreen() {
  const { channel: channelParam, collection: collectionId } = routeApi.useParams()
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const navigate = useNavigate()
  const query = usePromoCollection(model.code, collectionId)
  const channels = usePromoChannels(model.code)
  const catalog = useCatalogIndex(model.code).data?.byId ?? NO_CATALOG
  const info = useInfoPanel('promo-collection')
  const narrow = useMediaQuery('(max-width: 1319px)')
  const [handoffPanel, setHandoffPanel] = useHistoryState(
    HANDOFF_PANEL_KEY,
    HandoffPanelStateSchema,
    () => null,
  )
  const actions = usePromoActions()

  const collection = query.data
  // Канал — у самой подборки: адрес со старым или чужим каналом не путает крошки.
  const channel = collection?.channel ?? channelParam
  const selection = useMemberSelection(collectionId, collection?.members ?? [])
  const channelName = (id: string) =>
    channels.data?.find((candidate) => candidate.id === id)?.name ?? id
  // Пока каналы не пришли, крошка канала пустая, а не кодом «instagram».
  const crumbs = usePromoCrumbs({
    id: channel,
    name: channels.data ? channelName(channel) : '',
  })

  useKeyboardShortcut({ code: 'Escape', enabled: selection.selected.length > 0 }, selection.clear)
  useKeyboardShortcut(
    { code: 'Escape', enabled: selection.selected.length === 0 && handoffPanel !== null },
    () => setHandoffPanel(null),
  )

  const openMember = (member: CollectionMember) =>
    void navigate({ to: '/$model/i/$id', params: { model: model.code, id: member.item_id } })
  const remove = (members: readonly CollectionMember[]) =>
    actions.remove({
      channel,
      collection: collectionId,
      members: members.map(({ item_id, file_key }) => ({ item_id, file_key })),
      onRemoved: selection.clear,
    })

  // Передача выбранного: панель забирает выбор себе, полоса уступает место шапке.
  const prepareSelected = () => {
    setHandoffPanel({ show: 'new', members: selection.selected.map(memberKey) })
    selection.clear()
  }

  const menu = usePromoMenu()

  const notFound = query.error instanceof ApiError && query.error.status === 404

  // Экран-сущность из адреса, которой нет: общий 404 на всё поле (DESIGN §3.10).
  if (notFound) {
    return <NotFoundState message={`${collectionId} у ${model.name_genitive} нет`} />
  }
  return (
    <FieldLayout
      aside={
        collection ? (
          <CollectionAside
            collection={collection}
            handoffPanel={handoffPanel}
            onHandoffPanelChange={setHandoffPanel}
            infoOpen={info.open}
            info={{
              collection,
              selected: selection.selected,
              catalog,
              channelName,
              onOpenMember: openMember,
              onRemove: editable ? remove : null,
              onOpenHandoff: (id) => setHandoffPanel({ show: 'handoff', id }),
              onClose: info.close,
              width: info.width,
            }}
            narrow={narrow}
          />
        ) : null
      }
    >
      <FieldHeader
        crumbs={crumbs}
        title={collection?.title ?? collectionId}
        meta={collection ? `${collection.id} · ${mediaComposition(collection)}` : undefined}
        actions={
          editable && collection && handoffPanel === null ? (
            // Узкая шапка (панель открыта, 1280) сначала сворачивает кнопку в значок, и
            // только потом режет заголовок с объёмом (§3.2); синей при панели нет (§7.1).
            <HeaderAction
              icon={<PackageIcon />}
              label="Подготовить передачу"
              variant={info.open ? 'secondary' : 'default'}
              onClick={() => setHandoffPanel({ show: 'current' })}
            />
          ) : null
        }
        info={{ open: info.open, onToggle: info.toggle }}
        menu={menu}
        selectionBar={
          selection.selected.length > 0 ? (
            <SelectionBar count={selection.selected.length} onClear={selection.clear}>
              {editable ? (
                <>
                  <Button onClick={prepareSelected}>Подготовить передачу</Button>
                  <Button variant="bar" onClick={() => remove(selection.selected)}>
                    Убрать из подборки
                  </Button>
                </>
              ) : null}
            </SelectionBar>
          ) : undefined
        }
      />
      <RefreshStrip active={query.isFetching && collection !== undefined} />
      <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-3">
        <QueryErrorLine query={query} hasData={collection !== undefined} className="mb-3" />
        {query.isPending ? <CollectionSkeleton /> : null}
        {collection && collection.members.length === 0 ? (
          <EmptyState>
            В подборке пока ничего.
            {editable ? ' Выделите материалы в Библиотеке → В промо' : ''}
          </EmptyState>
        ) : null}
        {collection && collection.members.length > 0 ? (
          <MemberGrid
            collectionId={collection.id}
            members={collection.members}
            selectedKeys={selection.selectedKeys}
            onSelectedKeysChange={selection.setSelectedKeys}
            onOpen={openMember}
            selectable={editable}
            handedScope={{
              collectionId: collection.id,
              contractorId: collectionContractor(collection),
            }}
          />
        ) : null}
      </div>
    </FieldLayout>
  )
}
