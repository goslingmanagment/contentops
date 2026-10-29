import {
  type CatalogEntry,
  formatNumber,
  type ItemId,
  type TimelineHit,
} from '@contentops/contracts'
import { Skeleton } from '@contentops/ui/components/skeleton'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import type { ReactNode } from 'react'
import { useHref } from '@/app/use-href'
import { timelineTimecode } from '@/data/search'
import { itemCover } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'

export interface InboxDraft {
  group_id: string
  title: string
}

interface SearchExtrasProps {
  timeline: readonly TimelineHit[]
  drafts: readonly InboxDraft[]
  /** Сервер ещё ищет: у хронологии заготовки. */
  pending: boolean
  byId: ReadonlyMap<ItemId, CatalogEntry> | undefined
}

const HEADER = 52
const ROW = 52
const PENDING_ROWS = 2

/** Высота блока под плитками: сетка отводит ему место заранее, ничего не прыгает. */
export function searchExtrasHeight({ timeline, drafts, pending }: SearchExtrasProps): number {
  const timelineRows = pending ? PENDING_ROWS : timeline.length
  const block = (rows: number) => (rows > 0 ? HEADER + rows * ROW : 0)
  return block(timelineRows) + block(drafts.length)
}

function ExtrasHeader({ title, count }: { title: string; count: number | null }) {
  return (
    <h2 className="flex items-end px-2 pb-3 text-lg" style={{ height: HEADER }}>
      {title}
      {count === null ? null : (
        <span className="ml-1.5 font-normal text-ink-3 text-sm tabular-nums">
          {formatNumber(count)}
        </span>
      )}
    </h2>
  )
}

function ExtrasRow({
  href,
  thumb,
  children,
}: {
  href: string
  thumb: ReactNode
  children: ReactNode
}) {
  return (
    <li>
      <UiLink
        href={href}
        className="flex h-13 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent"
      >
        {thumb}
        <span className="min-w-0 flex-1 truncate text-base">{children}</span>
      </UiLink>
    </li>
  )
}

/**
 * Хронология и черновики под плитками результатов (DESIGN §4.7): «CUS-181 · 04:10 —
 * анал» открывает просмотр с этой минуты; «В Приехало · 2» ведёт к группе черновика.
 */
export function SearchExtras(props: SearchExtrasProps) {
  const { timeline, drafts, pending, byId } = props
  const model = useCurrentModel().code
  const href = useHref()
  return (
    <div className="flex flex-col">
      {pending ? (
        <section>
          <ExtrasHeader title="В хронологии" count={null} />
          {Array.from({ length: PENDING_ROWS }, (_, index) => (
            <div key={index} className="flex h-13 items-center gap-3 px-2">
              <Skeleton className="size-10 rounded-md" />
              <Skeleton className="h-3.5 w-64" />
            </div>
          ))}
        </section>
      ) : null}
      {!pending && timeline.length > 0 ? (
        <section>
          <ExtrasHeader title="В хронологии" count={timeline.length} />
          <ul>
            {timeline.map((hit) => {
              const entry = byId?.get(hit.item_id)
              return (
                <ExtrasRow
                  key={`${hit.item_id}:${hit.t_s}`}
                  href={href({
                    to: '/$model/i/$id',
                    params: { model, id: hit.item_id },
                    search: { view: 'master', t: hit.t_s },
                  })}
                  thumb={
                    entry ? (
                      <Thumb
                        {...itemCover(entry)}
                        aspect="1:1"
                        showCaptions={false}
                        className="w-10 shrink-0 rounded-md"
                      />
                    ) : null
                  }
                >
                  {hit.item_id} · {timelineTimecode(hit.t_s)} — {hit.label}
                  {entry ? <span className="ml-2 text-ink-3">{entry.title}</span> : null}
                </ExtrasRow>
              )
            })}
          </ul>
        </section>
      ) : null}
      {drafts.length > 0 ? (
        <section>
          <ExtrasHeader title="В Приехало" count={drafts.length} />
          <ul>
            {drafts.map((draft) => (
              <ExtrasRow
                key={draft.group_id}
                href={href({
                  to: '/$model/inbox/g/$group',
                  params: { model, group: draft.group_id },
                })}
                thumb={
                  <Thumb
                    seed={draft.group_id}
                    aspect="1:1"
                    showCaptions={false}
                    className="w-10 shrink-0 rounded-md"
                  />
                }
              >
                {draft.title}
              </ExtrasRow>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
