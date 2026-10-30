import { formatDate } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { UiLink } from '@contentops/ui/components/ui-link'
import { useToday } from '@/data/api-session'
import { filesWord } from '@/lib/words'
import { usePromoLinks } from '@/screens/promo/shared/promo-links'
import { useObjectPage } from '../object-context'

/**
 * Промо из исходного объекта (SPEC §7.1: «эти связи доступны и из исходного объекта»):
 * «в промо: PRM-015 · Instagram · GaranTTeam Social · 3 файла», «передавали: GaranTTeam
 * Social 18.09 (PRM-015) · 3 файла». Нет ни подборок, ни передач — блока нет.
 */
export function PromoSection() {
  const { detail } = useObjectPage()
  const links = usePromoLinks()
  const today = useToday()
  const { collections, handed } = detail.promo
  if (collections.length === 0 && handed.length === 0) return null
  return (
    <InfoSection title="Промо">
      <ul className="flex flex-col gap-1.5 text-base">
        {collections.map((collection) => (
          <li key={collection.id} className="min-w-0">
            <span className="text-ink-3">в промо: </span>
            <UiLink
              href={links.collection(collection.channel, collection.id)}
              className="text-primary-ink hover:underline"
            >
              {collection.id} · {collection.channel_name}
            </UiLink>
            <span className="text-ink-3">
              {collection.contractor ? ` · ${collection.contractor}` : ''} ·{' '}
              {filesWord(collection.files.length)}
            </span>
          </li>
        ))}
        {handed.map((given) => (
          <li
            key={`${given.collection_id}-${given.contractor}-${given.on}`}
            className="tabular-nums"
          >
            <span className="text-ink-3">передавали: </span>
            {given.contractor} {formatDate(given.on, today)} ({given.collection_id})
            <span className="text-ink-3"> · {filesWord(given.files.length)}</span>
          </li>
        ))}
      </ul>
    </InfoSection>
  )
}
