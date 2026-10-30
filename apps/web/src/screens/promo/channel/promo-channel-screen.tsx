import { ApiError, type CollectionMember } from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { usePromoChannel } from '@/data/promo'
import { useRole } from '@/data/session'
import { useHistoryScroll } from '@/lib/use-history-state'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { filesWord } from '@/lib/words'
import { NotFoundState } from '@/screens/errors'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePromoCrumbs } from '../promo-crumbs'
import { usePromoMenu } from '../shared/promo-menu'
import { channelComposition } from '../shared/promo-text'
import { useMemberSelection } from '../shared/use-member-selection'
import { ChannelSkeleton } from './channel-skeleton'
import { CollectionFolders } from './collection-folders'
import { unfiledDays } from './unfiled-days'
import { UnfiledGrid } from './unfiled-grid'
import { UnfiledSelectionBar } from './unfiled-selection-bar'
import { useUnfiledActions } from './use-unfiled-actions'

const routeApi = getRouteApi('/_shell/$model/library/promo/$channel')

const NO_MEMBERS: readonly CollectionMember[] = []

/**
 * Канал промо `/<модель>/library/promo/<канал>` (DESIGN §4.17): сверху подборки PRM
 * папками, ниже — все материалы канала по дням добавления, каждый файл один раз. Выбор
 * можно сразу подготовить к передаче: сначала заводится новая подборка (SPEC §7.1).
 */
export function PromoChannelScreen() {
  const { channel: channelId } = routeApi.useParams()
  const model = useCurrentModel()
  const role = useRole()
  const editable = role === 'owner' || role === 'manager'
  const navigate = useNavigate()
  const query = usePromoChannel(model.code, channelId)
  const crumbs = usePromoCrumbs('promo')
  const scroll = useHistoryScroll(`promo:channel:${channelId}:scroll`)
  const scrollRef = useRef<HTMLDivElement>(null)

  const contents = query.data
  const materials = contents?.materials ?? NO_MEMBERS
  const days = useMemo(() => unfiledDays(materials), [materials])
  const selection = useMemberSelection(`channel:${channelId}`, materials)
  const hasData = contents !== undefined

  useKeyboardShortcut({ code: 'Escape', enabled: selection.selected.length > 0 }, selection.clear)

  // Возврат в канал восстанавливает прокрутку, как только папки нарисованы (§3.13).
  useLayoutEffect(() => {
    if (hasData && scroll.initialOffset && scrollRef.current) {
      scrollRef.current.scrollTop = scroll.initialOffset
    }
  }, [hasData, scroll.initialOffset])

  const unfiledActions = useUnfiledActions(
    channelId,
    contents?.channel.name ?? channelId,
    selection,
  )

  const menu = usePromoMenu()

  const notFound = query.error instanceof ApiError && query.error.status === 404
  const empty = contents && contents.collections.length === 0 && materials.length === 0

  // Экран-сущность из адреса, которой нет: общий 404 на всё поле (DESIGN §3.10).
  if (notFound) {
    return <NotFoundState message={`Такого канала у ${model.name_genitive} нет`} />
  }
  return (
    <FieldLayout>
      <FieldHeader
        crumbs={crumbs}
        title={contents?.channel.name ?? ''}
        meta={
          contents && contents.channel.collection_count > 0
            ? channelComposition(contents.channel)
            : undefined
        }
        menu={menu}
        selectionBar={
          selection.selected.length > 0 && contents ? (
            <UnfiledSelectionBar
              count={selection.selected.length}
              collections={contents.collections}
              onPrepare={editable ? unfiledActions.prepare : null}
              onFile={unfiledActions.file}
              busy={unfiledActions.busy}
              onClear={selection.clear}
            />
          ) : undefined
        }
      />
      <RefreshStrip active={query.isFetching && hasData} />
      <div
        ref={scrollRef}
        onScroll={(event) => scroll.onScrollOffsetChange(event.currentTarget.scrollTop)}
        className="-mx-7 flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-3 pb-8"
      >
        <QueryErrorLine query={query} hasData={hasData} className="mb-3" />
        {query.isPending ? <ChannelSkeleton /> : null}
        {empty ? (
          <EmptyState>
            В {contents.channel.name} пока ничего.
            {editable ? ' Выделите материалы в Библиотеке → В промо' : ''}
          </EmptyState>
        ) : null}
        {contents && contents.collections.length > 0 ? (
          <CollectionFolders channel={channelId} collections={contents.collections} />
        ) : null}
        {days.length > 0 ? (
          <section aria-label="Материалы канала" className="mt-7 flex flex-col gap-2">
            <h2 className="flex items-baseline gap-2 text-lg">
              Материалы канала
              <span className="font-normal text-ink-3 text-sm tabular-nums">
                {filesWord(materials.length)}
              </span>
            </h2>
            <UnfiledGrid
              days={days}
              selectedKeys={selection.selectedKeys}
              onSelectedKeysChange={selection.setSelectedKeys}
              onOpen={(member) =>
                void navigate({
                  to: '/$model/i/$id',
                  params: { model: model.code, id: member.item_id },
                })
              }
              selectable={editable}
            />
          </section>
        ) : null}
      </div>
    </FieldLayout>
  )
}
