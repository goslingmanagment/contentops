import type { CatalogEntry, HubPost, ItemId } from '@contentops/contracts'
import { formatClock } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { ExternalLinkIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { itemCoverById } from '@/lib/item-cover'
import { type CompositionCheck, compositionOf, offsetLabel } from '../case-text'
import { MatchPhrase } from './pair-phrase'

/**
 * Стороны пары (DESIGN §4.15): наша миниатюра 9:16 × 160 и что видел Hub. Картинок с
 * платформы нет: Hub их не отдаёт. Длительность и состав называются один раз — в фразе
 * пары, если она есть, иначе под миниатюрой.
 */

interface PairSidesProps {
  /** «Fansly 2»: над правой стороной. */
  pageLabel: string
  ours: ReactNode
  theirs: ReactNode
}

/** Две колонки «Наше · Fansly 2»: у vault и у поста без плана, где сравнивать глазами. */
export function PairSides({ pageLabel, ours, theirs }: PairSidesProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <section aria-label="Наше" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-ink-3 text-sm">Наше</h3>
        {ours}
      </section>
      <section aria-label={pageLabel} className="flex min-w-0 flex-col gap-2">
        <h3 className="text-ink-3 text-sm">{pageLabel}</h3>
        {theirs}
      </section>
    </div>
  )
}

/** Наша миниатюра 9:16 высотой 160 без длительности: её говорит текст рядом. */
export function OurThumb({ itemId }: { itemId: ItemId }) {
  return (
    <Thumb
      {...itemCoverById(itemId)}
      aspect="9:16"
      className="h-40 w-auto shrink-0 self-start rounded-lg"
    />
  )
}

interface OurSideProps {
  itemId: ItemId
  entry: CatalogEntry | undefined
}

/** Наш состав словами: «видео 0:10», «38 фото, отобрано 22». */
export function OurComposition({ entry }: { entry: CatalogEntry }) {
  const composition = compositionOf(entry)
  return composition ? <p className="text-base tabular-nums">{composition}</p> : null
}

/** Наша миниатюра и под ней состав. */
export function OurSide({ itemId, entry }: OurSideProps) {
  return (
    <>
      <OurThumb itemId={itemId} />
      {entry ? <OurComposition entry={entry} /> : null}
    </>
  )
}

interface PostLinkProps {
  url: string
  /** «Пост на Fansly 2 ↗». */
  pageLabel: string
}

export function PostLink({ url, pageLabel }: PostLinkProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 self-start rounded-sm text-primary-ink text-sm underline-offset-4 hover:underline"
    >
      Пост на {pageLabel}
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </a>
  )
}

interface PostSideProps {
  post: HubPost
  /** «Пост на Fansly 2 ↗». */
  pageLabel: string
  /**
   * Состав поста против нашего: «22 фото — совпадает» или красное «≠ видео 0:10 и 0:07 —
   * не совпадает» встаёт на место состава поста. `null` — сравнивать не с чем.
   */
  match?: CompositionCheck | null
}

/** Что видел Hub: время поста и сдвиг, состав (или сравнение с нашим), подпись и ссылка. */
export function PostSide({ post, pageLabel, match = null }: PostSideProps) {
  const offset = offsetLabel(post.offset_min)
  return (
    <>
      <p className="text-base tabular-nums">
        <span className="whitespace-nowrap">Пост {formatClock(post.post_at)}</span>
        {offset ? <span className="whitespace-nowrap text-ink-3"> · {offset}</span> : null}
      </p>
      {match ? (
        <MatchPhrase text={match.text} matches={match.matches} />
      ) : post.summary ? (
        <p className="text-base tabular-nums">{post.summary}</p>
      ) : null}
      {post.caption ? <p className="text-muted-foreground text-sm">«{post.caption}»</p> : null}
      <PostLink url={post.url} pageLabel={pageLabel} />
    </>
  )
}
