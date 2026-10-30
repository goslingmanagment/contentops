import {
  type CatalogEntry,
  formatNumber,
  type Handoff,
  type ItemId,
  type PromoChannel,
  plural,
} from '@contentops/contracts'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { getRouteApi } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { usePromoChannels, usePromoHandoffs } from '@/data/promo'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePromoCrumbs } from '../promo-crumbs'
import { collectionsWord } from '../shared/promo-text'
import { ChannelFolders } from './channel-folders'
import { HandoffList } from './handoff-list'
import { PromoRootSkeleton } from './promo-root-skeleton'
import { type PromoView, PromoViewSwitch } from './promo-view-switch'

const routeApi = getRouteApi('/_shell/$model/library/promo')

function channelsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['канал', 'канала', 'каналов'])}`
}

/** В канале ничего нет: ни подборок, ни материалов для мозаики. */
function isEmptyChannel(channel: PromoChannel): boolean {
  return channel.collection_count === 0 && channel.covers.length === 0
}

/** «22 подборки · 6 каналов» у каналов, число передач у «Передач». */
function headerMeta(
  view: PromoView,
  channels: readonly PromoChannel[] | undefined,
  handoffs: readonly Handoff[] | undefined,
): string | undefined {
  if (view === 'handoffs') {
    return handoffs && handoffs.length > 0 ? formatNumber(handoffs.length) : undefined
  }
  if (!channels || channels.every(isEmptyChannel)) return undefined
  const collections = channels.reduce((sum, channel) => sum + channel.collection_count, 0)
  return `${collectionsWord(collections)} · ${channelsWord(channels.length)}`
}

/**
 * Промо — папка Библиотеки `/<модель>/library/promo` (DESIGN §4.17): каналы папками с
 * мозаикой или «Передачи» списком (`?view=handoffs`).
 */
export function PromoRootScreen() {
  const model = useCurrentModel()
  const { view: viewParam } = routeApi.useSearch()
  const view: PromoView = viewParam === 'handoffs' ? 'handoffs' : 'channels'
  const channels = usePromoChannels(model.code)
  const handoffs = usePromoHandoffs(model.code)
  const index = useCatalogIndex(model.code)
  const crumbs = usePromoCrumbs(view === 'channels' ? 'library' : 'promo')

  const collections = useMemo(
    () =>
      new Map(
        (index.data?.items ?? [])
          .filter((entry) => entry.type === 'promo')
          .map((entry) => [entry.id, entry]),
      ),
    [index.data],
  )
  const query = view === 'channels' ? channels : handoffs

  return (
    <FieldLayout>
      <FieldHeader
        crumbs={crumbs}
        title={view === 'channels' ? 'Промо' : 'Передачи'}
        meta={headerMeta(view, channels.data, handoffs.data)}
        nav={<PromoViewSwitch value={view} />}
      />
      <RefreshStrip active={query.isFetching && query.data !== undefined} />
      <div className="-mx-7 flex min-h-0 flex-1 flex-col px-7 pt-3">
        <QueryErrorLine query={query} hasData={query.data !== undefined} className="mb-3" />
        {query.isPending ? <PromoRootSkeleton view={view} /> : null}
        {view === 'channels' && channels.data ? <ChannelsBody channels={channels.data} /> : null}
        {view === 'handoffs' && handoffs.data ? (
          <HandoffsBody handoffs={handoffs.data} collections={collections} />
        ) : null}
      </div>
    </FieldLayout>
  )
}

function ChannelsBody({ channels }: { channels: readonly PromoChannel[] }) {
  if (channels.every(isEmptyChannel)) {
    return <EmptyState>Промо пока пустое. Выделите материалы в Библиотеке → В промо</EmptyState>
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-8">
      <ChannelFolders channels={channels} />
    </div>
  )
}

function HandoffsBody({
  handoffs,
  collections,
}: {
  handoffs: readonly Handoff[]
  collections: ReadonlyMap<ItemId, CatalogEntry>
}) {
  if (handoffs.length === 0) {
    return <EmptyState>Передач пока не было</EmptyState>
  }
  return <HandoffList handoffs={handoffs} collections={collections} />
}
