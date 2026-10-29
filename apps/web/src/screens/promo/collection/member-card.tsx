import {
  type CatalogEntry,
  type CollectionMember,
  formatDate,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { Fragment } from 'react'
import { useToday } from '@/data/api-session'
import { memberCover } from '../shared/member-cover'
import { usePromoLinks } from '../shared/promo-links'

interface MemberCardProps {
  member: CollectionMember
  /** Индекс каталога: название исходного объекта и каналы других подборок. */
  catalog: ReadonlyMap<ItemId, CatalogEntry>
  /** Имя канала по коду: «Twitter». */
  channelName: (channel: string) => string
  onOpen: () => void
  /** «Убрать из подборки»; у «Только чтение» кнопки нет. */
  onRemove: (() => void) | null
}

/**
 * Карточка материала в подборке (DESIGN §4.17): исходный объект со ссылкой, «загружен
 * 12.08 · добавлен в подборку 16.09», «Ещё в подборках: PRM-012 · Twitter»,
 * «Передавали: 18.09 · GaranTTeam Social (PRM-015)» — все передачи, и этой подборки тоже.
 */
export function MemberCard({ member, catalog, channelName, onOpen, onRemove }: MemberCardProps) {
  const today = useToday()
  const links = usePromoLinks()
  const cover = memberCover(member.thumb)
  const source = catalog.get(member.item_id)
  return (
    <>
      <div className="flex gap-4">
        <Thumb
          seed={cover.seed}
          kind={cover.kind}
          mediaAspect={cover.mediaAspect}
          className="w-33 shrink-0"
        />
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          <UiLink
            href={links.item(member.item_id)}
            className="truncate text-base text-primary-ink underline-offset-4 hover:underline"
          >
            {member.item_id}
          </UiLink>
          {source ? <p className="line-clamp-2 text-base">{source.title}</p> : null}
          <p className="text-muted-foreground text-sm">
            {member.media === 'video' ? 'видео' : 'фото'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onOpen}>
          Открыть
        </Button>
        {onRemove ? (
          <Button variant="outline" onClick={onRemove}>
            Убрать из подборки
          </Button>
        ) : null}
      </div>
      <InfoSection title="Даты">
        <p className="text-base tabular-nums">
          загружен {formatDate(member.uploaded_on, today)} · добавлен в подборку{' '}
          {formatDate(member.added_on, today)}
        </p>
      </InfoSection>
      {member.other_collections.length > 0 ? (
        <InfoSection title="Ещё в подборках">
          <p className="text-base">
            {member.other_collections.map((id, index) => {
              const channel = catalog.get(id)?.channel
              return (
                <Fragment key={id}>
                  {index > 0 ? ', ' : null}
                  {channel ? (
                    <UiLink
                      href={links.collection(channel, id)}
                      className="text-primary-ink underline-offset-4 hover:underline"
                    >
                      {id} · {channelName(channel)}
                    </UiLink>
                  ) : (
                    id
                  )}
                </Fragment>
              )
            })}
          </p>
        </InfoSection>
      ) : null}
      <InfoSection title="Передавали">
        {member.handed_to.length > 0 ? (
          <ul className="flex flex-col gap-1 text-base tabular-nums">
            {member.handed_to.map((given) => (
              <li key={`${given.collection_id}-${given.contractor_id}-${given.on}`}>
                {formatDate(given.on, today)} · {given.contractor} ({given.collection_id})
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base">ещё никому</p>
        )}
      </InfoSection>
    </>
  )
}
