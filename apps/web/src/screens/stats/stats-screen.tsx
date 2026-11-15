import type {
  StatsCommentPost,
  StatsDays,
  StatsMediaRow,
  StatsScreen as StatsScreenData,
  StatsSoldRow,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { cn } from '@contentops/ui/lib/utils'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { useStatsScreen } from '@/data/stats'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { MediaPanel } from './media-panel'
import type { StatsSearch } from './search'
import {
  count,
  DAYS_CHOICES,
  dayWords,
  fanslyPostUrl,
  mediaLine,
  mediaTitle,
  money,
  percent,
  share,
  statsStateWords,
  utcDayWords,
  watchShare,
} from './words'

const routeApi = getRouteApi('/_shell/$model/stats')

/** Сервер отдаёт не больше 200 медиа периода, самые просматриваемые. */
const SERVER_LIMIT = 200
const STEP = 50

/**
 * «Статистика» `/<модель>/stats` (план продуктов §2.4, пакет C2): что смотрят, покупают и комментируют на странице
 * модели. Цифры — Fansly, читает их Hub; ContentOps спрашивает их от имени вошедшего человека, по одной странице
 * Fansly. Что видно, решает Hub: владельцу — все страницы, контент-менеджеру — страницы его моделей.
 */
export function StatsScreen() {
  const search = routeApi.useSearch()
  const model = useCurrentModel()
  const navigate = useNavigate()
  const narrow = useMediaQuery('(max-width: 1319px)')
  const phone = useMediaQuery('(max-width: 639px)')
  const days = (search.days ?? 30) as StatsDays
  const screen = useStatsScreen(model.code, search.page, days)
  const data = screen.data
  const go = (next: Partial<StatsSearch>, replace = false) =>
    void navigate({
      to: '/$model/stats',
      params: { model: model.code },
      search: (prev: StatsSearch) =>
        Object.fromEntries(
          Object.entries({ ...prev, ...next }).filter(([, value]) => value !== undefined),
        ) as StatsSearch,
      replace,
    })
  const open = search.media ?? null
  useKeyboardShortcut({ code: 'Escape', enabled: open !== null }, () =>
    go({ media: undefined }, true),
  )
  const periodWords = DAYS_CHOICES.find((one) => one.value === String(days))?.words ?? ''
  const stateWords = data ? statsStateWords(data.hub) : null
  const page = data?.page ?? null
  const pageLabel = data?.pages.find((one) => one.hub_page === page)?.label ?? page ?? ''

  const panel =
    open !== null && page !== null ? (
      <MediaPanel
        key={`${page}:${open}`}
        media={open}
        page={page}
        days={days}
        row={data?.media.find((one) => one.media_offer_id === open) ?? null}
        sold={data?.top_sales.find((one) => one.media_offer_id === open) ?? null}
        topSalesTotal={data?.top_sales_total ?? 0}
        topSalesShown={data?.top_sales.length ?? 0}
        width={phone || narrow ? 'narrow' : 'wide'}
        className={phone ? 'w-full border-l-0' : undefined}
        onClose={() => go({ media: undefined }, true)}
      />
    ) : null
  // На телефоне карточка закрывает экран: две колонки там не помещаются.
  if (phone && panel) return <FieldLayout>{panel}</FieldLayout>

  return (
    <FieldLayout aside={panel}>
      <FieldHeader title="Статистика" />
      <div className="flex flex-col gap-3 pb-2">
        <ChoiceChips
          label="Период"
          choices={DAYS_CHOICES.map((one) => ({ value: one.value, label: one.label }))}
          value={String(days) as `${StatsDays}`}
          onChange={(value) => go({ days: Number(value) })}
        />
        {data && data.pages.length > 1 ? (
          <ChoiceChips
            label="Страница"
            choices={data.pages.map((one) => ({ value: one.hub_page, label: one.label }))}
            value={page ?? ''}
            onChange={(value) => go({ page: value, media: undefined })}
          />
        ) : null}
        {data?.window ? (
          <p className="text-muted-foreground text-sm">
            {pageLabel ? `${pageLabel} · ` : ''}
            {utcDayWords(data.window.from_day)} – {utcDayWords(data.window.to_day)}
            {data.updated_at ? ` · медиа прочитаны ${dayWords(data.updated_at)}` : ''}
          </p>
        ) : null}
        {data?.walk && data.walk.queued > 0 && data.walk.visited < data.walk.queued ? (
          <p className="text-attention-ink text-sm">
            Первый проход ещё идёт: прочитано {count(data.walk.visited)} из{' '}
            {count(data.walk.queued)} медиа. Суммы пока неполные.
          </p>
        ) : null}
      </div>
      <RefreshStrip active={screen.isFetching && data !== undefined} />
      <div className="@container -mx-7 flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto px-7 pt-2 pb-8">
        <QueryErrorLine query={screen} hasData={data !== undefined} />
        {screen.isPending ? <p className="text-muted-foreground text-sm">Загружаем…</p> : null}
        {stateWords ? <EmptyState>{stateWords}</EmptyState> : null}
        {data?.hub === 'ok' && page === null ? (
          <EmptyState>У модели нет страниц Fansly: статистики здесь нет.</EmptyState>
        ) : null}
        {data?.hub === 'ok' && page !== null ? (
          <>
            <MediaTable
              rows={data.media}
              pageLabel={pageLabel}
              periodWords={periodWords}
              phone={phone}
              openId={open}
              onOpen={(id) => go({ media: id })}
            />
            <TopSales
              data={data}
              pageLabel={pageLabel}
              openId={open}
              onOpen={(id) => go({ media: id })}
            />
            <Comments data={data} pageLabel={pageLabel} periodWords={periodWords} />
            <HowCounted />
          </>
        ) : null}
      </div>
    </FieldLayout>
  )
}

type SortKey = 'posted' | 'views' | 'for_you' | 'timeline' | 'watch' | 'completion' | 'likes'
type Kind = 'all' | 'video' | 'image'

function sortValue(row: StatsMediaRow, key: SortKey): number | null {
  switch (key) {
    case 'posted':
      return row.posted_at ? Date.parse(row.posted_at) : null
    case 'views':
      return row.views
    case 'for_you':
      return row.for_you_views
    case 'timeline':
      return row.timeline_views
    case 'watch':
      return watchShare(row.watch_pct_sum, row.video_views)
    case 'completion':
      return share(row.completed_views, row.video_views)
    case 'likes':
      return row.likes
  }
}

/** Строка открывает карточку медиа: щелчок, Enter или пробел. */
function opener(open: () => void) {
  return {
    tabIndex: 0,
    role: 'button',
    onClick: open,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    },
  } as const
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-base">{title}</h2>
      {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
      {children}
    </section>
  )
}

const TH = 'px-2 py-2 text-left font-normal text-muted-foreground'
const NUM = 'px-2 py-2 text-right tabular-nums'

/** «Медиа за период»: медиа страницы по просмотрам периода; строка открывает карточку. */
function MediaTable({
  rows,
  pageLabel,
  periodWords,
  phone,
  openId,
  onOpen,
}: {
  rows: readonly StatsMediaRow[]
  pageLabel: string
  periodWords: string
  phone: boolean
  openId: string | null
  onOpen: (id: string) => void
}) {
  const [sort, setSort] = useState<SortKey>('views')
  const [desc, setDesc] = useState(true)
  const [kind, setKind] = useState<Kind>('all')
  const [shown, setShown] = useState(STEP)
  const sorted = useMemo(() => {
    const picked = rows.filter(
      (row) => kind === 'all' || (kind === 'video' ? row.media_type === 2 : row.media_type === 1),
    )
    return [...picked].sort((left, right) => {
      const a = sortValue(left, sort)
      const b = sortValue(right, sort)
      if (a === null && b === null) return 0
      if (a === null) return 1
      if (b === null) return -1
      return desc ? b - a : a - b
    })
  }, [rows, kind, sort, desc])
  const head = (label: string, key: SortKey, num = true) => (
    <th
      scope="col"
      className={cn(TH, num && 'text-right')}
      aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className={cn('hover:text-foreground', sort === key && 'text-foreground')}
        onClick={() => {
          setShown(STEP)
          if (key === sort) setDesc(!desc)
          else {
            setSort(key)
            setDesc(true)
          }
        }}
      >
        {label}
        {sort === key ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
  const page = sorted.slice(0, shown)
  return (
    <Section title="Медиа за период">
      <div className="flex flex-wrap items-center gap-3">
        <ChoiceChips
          label="Вид медиа"
          choices={[
            { value: 'all', label: 'Все' },
            { value: 'video', label: 'Видео' },
            { value: 'image', label: 'Фото' },
          ]}
          value={kind}
          onChange={(value) => {
            setKind(value)
            setShown(STEP)
          }}
        />
        {rows.length >= SERVER_LIMIT ? (
          <span className="text-muted-foreground text-sm">
            Показаны 200 самых просматриваемых за период
          </span>
        ) : null}
      </div>
      {sorted.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {kind === 'all'
            ? `На ${pageLabel} за ${periodWords} просмотров медиа нет: обход только начался или медиа не смотрели.`
            : `На ${pageLabel} за ${periodWords} просмотренных ${kind === 'video' ? 'видео' : 'фото'} нет.`}
        </p>
      ) : phone ? (
        <ul className="flex flex-col">
          {page.map((row) => (
            <li
              key={row.media_offer_id}
              {...opener(() => onOpen(row.media_offer_id))}
              className={cn(
                'flex flex-col gap-0.5 border-border border-b py-2.5',
                openId === row.media_offer_id && 'bg-primary-tint',
              )}
            >
              <span className="text-sm">{mediaTitle(row)}</span>
              <span className="text-muted-foreground text-xs">{mediaLine(row)}</span>
              <span className="text-sm tabular-nums">
                {count(row.views)} просм. · For You {count(row.for_you_views)} · досмотр{' '}
                {percent(watchShare(row.watch_pct_sum, row.video_views))} · лайки {count(row.likes)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-border border-b">
              <tr>
                {head('Медиа и дата выхода', 'posted', false)}
                {head('Просмотры', 'views')}
                {head('For You', 'for_you')}
                {head('Лента подписок', 'timeline')}
                {head('Досмотр', 'watch')}
                {head('До конца', 'completion')}
                {head('Лайки', 'likes')}
              </tr>
            </thead>
            <tbody>
              {page.map((row) => (
                <tr
                  key={row.media_offer_id}
                  aria-label={`Открыть карточку: ${mediaTitle(row)}`}
                  {...opener(() => onOpen(row.media_offer_id))}
                  className={cn(
                    'cursor-pointer border-border border-b hover:bg-accent',
                    openId === row.media_offer_id && 'bg-primary-tint',
                  )}
                >
                  <td className="px-2 py-2">
                    <div>{mediaTitle(row)}</div>
                    <div className="text-muted-foreground text-xs">{mediaLine(row)}</div>
                  </td>
                  <td className={NUM}>{count(row.views)}</td>
                  <td className={NUM}>{count(row.for_you_views)}</td>
                  <td className={NUM}>{count(row.timeline_views)}</td>
                  <td className={NUM}>{percent(watchShare(row.watch_pct_sum, row.video_views))}</td>
                  <td className={NUM}>{percent(share(row.completed_views, row.video_views))}</td>
                  <td className={NUM}>{count(row.likes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sorted.length > shown ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setShown(shown + STEP)}
        >
          Показать ещё {Math.min(STEP, sorted.length - shown)} из {sorted.length - shown}
        </Button>
      ) : null}
    </Section>
  )
}

/** «Что покупают»: медиа страницы по продажам после комиссии, за всё время; порядок — Hub. */
function TopSales({
  data,
  pageLabel,
  openId,
  onOpen,
}: {
  data: StatsScreenData
  pageLabel: string
  openId: string | null
  onOpen: (id: string) => void
}) {
  const [shown, setShown] = useState(20)
  const rows: readonly StatsSoldRow[] = data.top_sales
  const more = data.top_sales_total > rows.length
  return (
    <Section
      title="Что покупают"
      note="За всё время, не за выбранный период: Fansly отдаёт продажи только итогом."
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">На {pageLabel} проданных медиа нет.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-border border-b">
              <tr>
                <th scope="col" className={TH}>
                  Медиа
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Цена
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Продано
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  После комиссии
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  До комиссии, расчёт
                </th>
                <th scope="col" className={cn(TH, 'text-right')}>
                  Просмотры за период
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => (
                <tr
                  key={row.media_offer_id}
                  aria-label={`Открыть карточку: ${mediaTitle(row)}`}
                  {...opener(() => onOpen(row.media_offer_id))}
                  className={cn(
                    'cursor-pointer border-border border-b hover:bg-accent',
                    openId === row.media_offer_id && 'bg-primary-tint',
                  )}
                >
                  <td className="px-2 py-2">
                    <div>{mediaTitle(row)}</div>
                    <div className="text-muted-foreground text-xs">{mediaLine(row)}</div>
                  </td>
                  <td className={NUM}>{money(row.price_mills)}</td>
                  <td className={NUM}>{count(row.sales_count)}</td>
                  <td className={NUM}>{money(row.net_mills)}</td>
                  <td className={cn(NUM, 'text-muted-foreground')}>{money(row.gross_mills)}</td>
                  <td className={NUM}>{count(row.window_views)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setShown(rows.length)}
        >
          Показать все {rows.length}
        </Button>
      ) : null}
      {more && rows.length > 0 ? (
        <p className="text-muted-foreground text-sm">
          Показаны {count(rows.length)} из {count(data.top_sales_total)} проданных
        </p>
      ) : null}
    </Section>
  )
}

const CUT = 70
const cut = (text: string) => {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > CUT ? `${clean.slice(0, CUT).trimEnd()}…` : clean
}

/** «Комментарии к постам» за те же дни; пост назван текстом, не номером. */
function Comments({
  data,
  pageLabel,
  periodWords,
}: {
  data: StatsScreenData
  pageLabel: string
  periodWords: string
}) {
  const [shown, setShown] = useState(20)
  const { state, posts } = data.comments
  const captionOf = (post: StatsCommentPost) =>
    post.caption?.trim()
      ? post.caption
      : (data.media.find((row) => row.post_id === post.post_ref && row.caption?.trim())?.caption ??
        null)
  return (
    <Section
      title="Комментарии к постам"
      note={
        state === 'in_progress'
          ? 'Сколько комментариев у постов за период. Сбор ещё идёт: за часть периода их может не быть.'
          : 'Сколько комментариев у постов за период, сначала посты с новыми.'
      }
    >
      {state === 'failed' ? (
        <p className="text-muted-foreground text-sm">
          Комментарии сейчас не загрузились: обновите чуть позже.
        </p>
      ) : state === 'never_read' ? (
        <p className="text-muted-foreground text-sm">
          Комментарии для {pageLabel} ещё не собирались. Это не ноль.
        </p>
      ) : posts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          На {pageLabel} за {periodWords} комментариев не собрано.
        </p>
      ) : (
        <ul className="flex flex-col">
          {posts.slice(0, shown).map((post) => {
            const caption = captionOf(post)
            return (
              <li
                key={post.post_ref}
                className="flex items-baseline justify-between gap-3 border-border border-b py-2.5 text-sm"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{caption ? cut(caption) : 'Пост без подписи'}</span>
                  <span className="text-muted-foreground text-xs">
                    {post.published_at ? `вышел ${dayWords(post.published_at)} · ` : ''}
                    <a
                      className="underline underline-offset-2"
                      href={fanslyPostUrl(post.post_ref)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Открыть на Fansly
                    </a>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5 tabular-nums">
                  <span>{count(post.comment_count)} комм.</span>
                  {post.missing_count > 0 ? (
                    <span className="text-muted-foreground text-xs">
                      пропали {count(post.missing_count)}
                    </span>
                  ) : null}
                  {post.possibly_truncated_count > 0 ? (
                    <span className="text-attention-ink text-xs">
                      возможно, не все ({count(post.possibly_truncated_count)})
                    </span>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {posts.length > shown ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setShown(posts.length)}
        >
          Показать все {posts.length}
        </Button>
      ) : null}
    </Section>
  )
}

function HowCounted() {
  return (
    <InfoSection title="Как считается">
      <div className="flex flex-col gap-2 text-muted-foreground text-sm">
        <p>
          Строки таблицы — дневные данные Fansly по каждому медиа, сложенные за период. Медиа
          обходятся сами: новые каждые 6 часов, до 30 дней ежедневно, старше реже.
        </p>
        <p>
          For You показывает только видео и только первые 90 дней после публикации, поэтому у фото и
          старых видео прочерк.
        </p>
        <p>
          Досмотр — средняя доля видео, которую посмотрели. До конца — доля просмотров, дошедших до
          конца. За всё время — итог Fansly. Лайки — числа; кто именно лайкнул, Fansly не отдаёт.
        </p>
        <p>
          Продажи Fansly отдаёт только итогом за всё время, поэтому «Что покупают» от периода не
          зависит. Большинство таких медиа продано в сообщениях: поста и подписи у них нет. «До
          комиссии, расчёт» — после комиссии ÷ 0,8; с суммой после комиссии её не складываем.
        </p>
        <p>
          «Возможно, не все» — у поста была подозрительно полная страница ответов, а надёжно листать
          дальше Fansly не даёт. «Пропали» — комментарии, которых больше нет на Fansly.
        </p>
      </div>
    </InfoSection>
  )
}
