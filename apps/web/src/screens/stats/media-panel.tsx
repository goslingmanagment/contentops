import type { StatsDays, StatsMediaCard, StatsMediaRow, StatsSoldRow } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { PanelFrame, type PanelFrameWidth } from '@contentops/ui/components/panel-frame'
import { cn } from '@contentops/ui/lib/utils'
import type { ReactNode } from 'react'
import { useStatsMedia } from '@/data/stats'
import { useCurrentModel } from '@/shell/model/model-context'
import {
  count,
  fanslyPostUrl,
  mediaLine,
  mediaTitle,
  money,
  percent,
  share,
  sourceStroke,
  sourceTone,
  sourceWord,
  utcDayWords,
  watchShare,
} from './words'

/** Меньше зрителей — кривая удержания шум. */
const RETENTION_MIN_SAMPLE = 5
const TAGS_SHOWN = 20

/**
 * Карточка медиа (`?media=`): цифры периода — из строки списка, дни по источникам, удержание, первые часы и теги —
 * из Hub по запросу, продажи — из «Что покупают» (за всё время).
 */
export function MediaPanel({
  media,
  page,
  days,
  row,
  sold,
  topSalesTotal,
  topSalesShown,
  width,
  className,
  onClose,
}: {
  media: string
  page: string
  days: StatsDays
  row: StatsMediaRow | null
  sold: StatsSoldRow | null
  topSalesTotal: number
  topSalesShown: number
  width: PanelFrameWidth
  className?: string | undefined
  onClose: () => void
}) {
  const model = useCurrentModel()
  const detail = useStatsMedia(model.code, media, page, days)
  const head = row ?? sold
  const postId = row?.post_id ?? sold?.post_id ?? null
  const title = head ? mediaTitle(head) : detail.isError ? 'Медиа не найдено' : 'Медиа'
  return (
    <PanelFrame
      label="Карточка медиа"
      title={title}
      width={width}
      onClose={onClose}
      className={className}
    >
      <div className="flex flex-col gap-5 pb-6">
        <div className="flex flex-col gap-1 text-sm">
          {head ? <span className="text-muted-foreground">{mediaLine(head, true)}</span> : null}
          {postId ? (
            <a
              className="self-start underline underline-offset-2"
              href={fanslyPostUrl(postId)}
              target="_blank"
              rel="noreferrer"
            >
              Открыть пост на Fansly
            </a>
          ) : (
            <span className="text-muted-foreground">пост не найден</span>
          )}
        </div>

        <InfoSection title="За период">
          {row === null ? (
            <p className="pb-2 text-muted-foreground text-sm">В списке этого периода его нет.</p>
          ) : null}
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
            <Line term="Просмотры">{count(row?.views)}</Line>
            <Line term="For You">{count(row?.for_you_views)}</Line>
            <Line term="Лента подписок">{count(row?.timeline_views)}</Line>
            {row?.other_views ? <Line term="Другое">{count(row.other_views)}</Line> : null}
            <Line term="Досмотр">
              {percent(row ? watchShare(row.watch_pct_sum, row.video_views) : null)}
            </Line>
            <Line term="До конца">
              {percent(row ? share(row.completed_views, row.video_views) : null)}
            </Line>
            <Line term="Лайки">{count(row?.likes)}</Line>
            <Line term="За всё время">{count(row?.all_time_views)}</Line>
          </dl>
        </InfoSection>

        <InfoSection title="Продажи, за всё время">
          {sold ? (
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <Line term="Цена">{money(sold.price_mills)}</Line>
              <Line term="Продано">{count(sold.sales_count)}</Line>
              <Line term="После комиссии">{money(sold.net_mills)}</Line>
              <Line term="До комиссии, расчёт">
                <span className="text-muted-foreground">{money(sold.gross_mills)}</span>
              </Line>
            </dl>
          ) : (
            <p className="text-muted-foreground text-sm">
              {topSalesTotal > topSalesShown
                ? `Не среди ${topSalesShown} самых продаваемых медиа страницы.`
                : 'Продаж нет.'}
            </p>
          )}
        </InfoSection>

        {detail.isPending ? <p className="text-muted-foreground text-sm">Загружаем…</p> : null}
        {detail.isError ? (
          <p className="text-muted-foreground text-sm">
            {detail.error instanceof Error ? detail.error.message : 'Не загрузилось'}
          </p>
        ) : null}
        {detail.data ? <Detail card={detail.data} /> : null}
      </div>
    </PanelFrame>
  )
}

function Detail({ card }: { card: StatsMediaCard }) {
  const curves = card.retention.filter(
    (curve) => curve.points.length > 0 && (curve.sample_size ?? 0) >= RETENTION_MIN_SAMPLE,
  )
  return (
    <>
      <InfoSection title="Просмотры по дням">
        {card.daily.length === 0 ? (
          <p className="text-muted-foreground text-sm">Нет дневных данных за период.</p>
        ) : (
          <Bars
            points={card.daily.map((one) => ({
              at: one.day,
              source: one.source,
              views: one.views,
            }))}
            label={utcDayWords}
          />
        )}
      </InfoSection>
      <InfoSection title="Удержание">
        {curves.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Кривой удержания нет: фото или меньше {RETENTION_MIN_SAMPLE} зрителей.
          </p>
        ) : (
          <Retention curves={curves} />
        )}
      </InfoSection>
      {card.hourly.length > 0 ? (
        <InfoSection title="Первые часы">
          <Bars
            points={card.hourly.map((one) => ({
              at: one.hour,
              source: one.source,
              views: one.views,
            }))}
            label={(hour) =>
              new Intl.DateTimeFormat('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Europe/Moscow',
              }).format(new Date(hour))
            }
          />
        </InfoSection>
      ) : null}
      {card.tags.length > 0 ? (
        <InfoSection title="По каким тегам находили">
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {card.tags.slice(0, TAGS_SHOWN).map((tag) => (
              <li key={`${tag.tag}-${tag.source}`}>
                #{tag.tag}{' '}
                <span className="text-muted-foreground tabular-nums">{count(tag.views)}</span>
              </li>
            ))}
          </ul>
        </InfoSection>
      ) : null}
    </>
  )
}

function Legend({ sources }: { sources: readonly number[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
      {sources.map((source) => (
        <li key={source} className="flex items-center gap-1.5">
          <span className={cn('size-2 rounded-full', sourceTone(source))} aria-hidden />
          {sourceWord(source)}
        </li>
      ))}
    </ul>
  )
}

/** Столбики по дням (или часам), сложенные по источникам; высота — от самого большого столбика. */
function Bars({
  points,
  label,
}: {
  points: readonly { at: string; source: number; views: number | null }[]
  label: (at: string) => string
}) {
  const sources = [...new Set(points.map((one) => one.source))].sort((a, b) => a - b)
  const buckets = [...new Set(points.map((one) => one.at))].sort().map((at) => {
    const parts = sources.map((source) => ({
      source,
      views: points
        .filter((one) => one.at === at && one.source === source)
        .reduce((sum, one) => sum + (one.views ?? 0), 0),
    }))
    return { at, parts, total: parts.reduce((sum, part) => sum + part.views, 0) }
  })
  const top = Math.max(1, ...buckets.map((bucket) => bucket.total))
  return (
    <div className="flex flex-col gap-2">
      <Legend sources={sources} />
      <div className="flex h-32 items-end gap-px" role="img" aria-label="Просмотры по времени">
        {buckets.map((bucket) => (
          <div
            key={bucket.at}
            className="flex min-w-0 flex-1 flex-col-reverse"
            style={{ height: `${(bucket.total / top) * 100}%` }}
            title={`${label(bucket.at)}: ${count(bucket.total)}`}
          >
            {bucket.parts.map((part) =>
              part.views > 0 ? (
                <div
                  key={part.source}
                  className={sourceTone(part.source)}
                  style={{ height: `${(part.views / Math.max(1, bucket.total)) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-muted-foreground text-xs tabular-nums">
        <span>{buckets[0] ? label(buckets[0].at) : ''}</span>
        <span>самый большой: {count(top)}</span>
        <span>{buckets.at(-1) ? label(buckets.at(-1)?.at ?? '') : ''}</span>
      </div>
    </div>
  )
}

/** Кривые удержания: сколько ещё смотрят (ось вверх) на каждой доле видео (ось вправо). */
function Retention({ curves }: { curves: StatsMediaCard['retention'] }) {
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {curves.map((curve) => (
          <li key={curve.source} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', sourceTone(curve.source))} aria-hidden />
            {sourceWord(curve.source)}
            {curve.sample_size === null ? '' : `, ${count(curve.sample_size)} зрителей`}
          </li>
        ))}
      </ul>
      <svg
        viewBox="0 0 100 50"
        className="h-32 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Удержание"
      >
        <line x1="0" y1="50" x2="100" y2="50" className="stroke-border" strokeWidth="0.5" />
        <line x1="0" y1="25" x2="100" y2="25" className="stroke-border" strokeWidth="0.3" />
        {curves.map((curve) => (
          <polyline
            key={curve.source}
            fill="none"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            className={sourceStroke(curve.source)}
            points={[...curve.points]
              .sort((a, b) => a.percent - b.percent)
              .map((point) => `${point.percent},${50 - point.still_watching * 50}`)
              .join(' ')}
          />
        ))}
      </svg>
      <div className="flex justify-between text-muted-foreground text-xs">
        <span>начало видео</span>
        <span>половина</span>
        <span>конец</span>
      </div>
    </div>
  )
}

function Line({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  )
}
