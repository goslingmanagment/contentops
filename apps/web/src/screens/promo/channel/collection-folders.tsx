import {
  type ChannelContents,
  formatDate,
  formatPercent,
  type Handoff,
} from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { useToday } from '@/data/api-session'
import { mosaicLayoutOf, mosaicOf } from '../shared/member-cover'
import { PromoFolderGrid } from '../shared/promo-folder-grid'
import { usePromoLinks } from '../shared/promo-links'
import { breakBetweenParts, mediaComposition } from '../shared/promo-text'

type CollectionSummary = ChannelContents['collections'][number]

/**
 * Последняя передача на плитке подборки: «✓ передано 18.09», под ней подрядчик — вместе
 * они шире плитки, и обрезать не приходится ни дату, ни имя.
 */
function LastHandoff({ handoff }: { handoff: Handoff }) {
  const today = useToday()
  if (handoff.state === 'sent' && handoff.sent_on) {
    return (
      <span className="flex min-w-0 max-w-full flex-col items-center">
        <StatusWord sign="done" className="max-w-full">
          передано {formatDate(handoff.sent_on, today)}
        </StatusWord>
        <span className="max-w-full truncate">{handoff.contractor_name}</span>
      </span>
    )
  }
  // Строка папки — одна строка 18: ход сборки словом, без полоски.
  const progress =
    handoff.state === 'preparing' && handoff.progress !== null
      ? ` ${formatPercent(handoff.progress)}`
      : ''
  return (
    <StatusWord sign={handoff.status.sign ?? undefined} className="max-w-full">
      {handoff.status.word}
      {progress}
    </StatusWord>
  )
}

/**
 * Подборки канала папками (DESIGN §4.17): мозаика, название, «PRM-015 · 60 видео ·
 * 2,65 ГБ» и последняя передача словом; длинный состав переносится по частям. Новые
 * подборки — первыми.
 */
export function CollectionFolders({
  channel,
  collections,
}: {
  channel: string
  collections: readonly CollectionSummary[]
}) {
  const links = usePromoLinks()
  const newestFirst = [...collections].sort((left, right) => right.id.localeCompare(left.id))
  return (
    <PromoFolderGrid
      label="Подборки"
      folders={newestFirst.map((collection) => {
        const last = collection.handoffs.at(-1)
        return {
          key: collection.id,
          href: links.collection(channel, collection.id),
          name: collection.title,
          composition: breakBetweenParts(`${collection.id} · ${mediaComposition(collection)}`),
          note: last ? <LastHandoff handoff={last} /> : undefined,
          tiles: mosaicOf(collection.covers),
          layout: mosaicLayoutOf(collection.covers),
        }
      })}
    />
  )
}
