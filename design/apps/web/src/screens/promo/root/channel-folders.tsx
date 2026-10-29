import { formatDate, type PromoChannel } from '@contentops/contracts'
import { useToday } from '@/data/api-session'
import { mosaicLayoutOf, mosaicOf } from '../shared/member-cover'
import { PromoFolderGrid } from '../shared/promo-folder-grid'
import { usePromoLinks } from '../shared/promo-links'
import { channelComposition } from '../shared/promo-text'

/**
 * Каналы папками с мозаикой (DESIGN §4.17): «Instagram», «6 подборок · 1 680 файлов»,
 * «последняя передача 18.09». У YouTube кадры 16:9 вписаны в ячейки.
 */
export function ChannelFolders({ channels }: { channels: readonly PromoChannel[] }) {
  const today = useToday()
  const links = usePromoLinks()
  return (
    <PromoFolderGrid
      label="Каналы"
      folders={channels.map((channel) => ({
        key: channel.id,
        href: links.channel(channel.id),
        name: channel.name,
        composition: channelComposition(channel),
        note: channel.last_handoff_on
          ? `последняя передача ${formatDate(channel.last_handoff_on, today)}`
          : undefined,
        tiles: mosaicOf(channel.covers),
        layout: mosaicLayoutOf(channel.covers),
      }))}
    />
  )
}
