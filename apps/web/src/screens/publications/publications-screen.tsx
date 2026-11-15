import {
  formatClock,
  formatDateWords,
  formatNumber,
  type Instant,
  mskDate,
  type PublicationPage,
  type PublicationRow,
  type PublicationWindow,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { FieldHeader } from '@contentops/ui/components/field-header'
import { EmptyState } from '@contentops/ui/components/state-lines'
import { StatusWord } from '@contentops/ui/components/status-word'
import { cn } from '@contentops/ui/lib/utils'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'
import { useToday } from '@/data/api-session'
import { usePublicationsFeed } from '@/data/publications'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useMediaQuery } from '@/lib/use-media-query'
import { accountLabel } from '@/lib/words'
import { FieldLayout } from '@/shell/field/field-layout'
import { QueryErrorLine } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useCurrentModel } from '@/shell/model/model-context'
import { PublicationPanel } from './publication-panel'
import type { PublicationsSearch } from './search'
import { SettingsPanel } from './settings-panel'
import { usePublicationActions } from './use-publication-actions'
import {
  filesWord,
  formatMills,
  hubStateWords,
  KIND_WORDS,
  SEGMENTS,
  statusWord,
  WINDOW_CHOICES,
} from './words'

const routeApi = getRouteApi('/_shell/$model/publications')

type Segment = (typeof SEGMENTS)[number]['value']

/**
 * «Публикации» `/<модель>/publications` (план продуктов §2.4, пакет C2): что и когда выйдет на страницах модели —
 * лента по дням, расписание каждой страницы, карточка поста. Движок — Hub: он ставит посты, отправляет их на
 * площадку и пишет, что вышло. ContentOps читает это от имени вошедшего человека: что видно и что можно, решает Hub.
 */
export function PublicationsScreen() {
  const search = routeApi.useSearch()
  const model = useCurrentModel()
  const navigate = useNavigate()
  const narrow = useMediaQuery('(max-width: 1319px)')
  const window: PublicationWindow = search.window ?? (search.status ? 'all' : 'next7')
  const feed = usePublicationsFeed(model.code, { window, status: search.status, page: search.page })
  const open = search.post ?? search.publication ?? null
  const go = (next: Partial<PublicationsSearch>, replace = false) =>
    void navigate({
      to: '/$model/publications',
      params: { model: model.code },
      search: (prev: PublicationsSearch) => {
        const merged: PublicationsSearch = { ...prev, ...next }
        delete merged.publication
        return Object.fromEntries(
          Object.entries(merged).filter(([, value]) => value !== undefined),
        ) as PublicationsSearch
      },
      replace,
    })
  const actions = usePublicationActions((id) => go({ post: id }))
  useKeyboardShortcut({ code: 'Escape', enabled: open !== null }, () =>
    go({ post: undefined }, true),
  )

  const data = feed.data
  const segment: Segment | null =
    search.status === undefined
      ? 'all'
      : (SEGMENTS.find((one) => one.status === search.status)?.value ?? null)
  const days = useMemo(
    () => byDay(data?.publications ?? [], data?.pages ?? [], search.page),
    [data, search.page],
  )
  const stateWords = data ? hubStateWords(data.hub) : null
  const phone = useMediaQuery('(max-width: 639px)')
  // На телефоне карточка и настройки закрывают ленту: две колонки там не помещаются.
  if (phone && open !== null) {
    return (
      <FieldLayout>
        <PublicationPanel
          actions={actions}
          id={open}
          width="narrow"
          className="w-full border-l-0"
          onClose={() => go({ post: undefined }, true)}
        />
      </FieldLayout>
    )
  }
  if (phone && search.panel === 'settings' && data) {
    return (
      <FieldLayout>
        <SettingsPanel
          pages={data.pages}
          actions={actions}
          width="narrow"
          className="w-full border-l-0"
          onClose={() => go({ panel: undefined }, true)}
        />
      </FieldLayout>
    )
  }

  return (
    <FieldLayout
      aside={
        open !== null ? (
          <PublicationPanel
            actions={actions}
            id={open}
            width={narrow ? 'narrow' : 'wide'}
            onClose={() => go({ post: undefined }, true)}
          />
        ) : search.panel === 'settings' && data ? (
          <SettingsPanel
            pages={data.pages}
            actions={actions}
            width={narrow ? 'narrow' : 'wide'}
            onClose={() => go({ panel: undefined }, true)}
          />
        ) : null
      }
    >
      <FieldHeader
        title="Публикации"
        count={data?.publications.length}
        actions={
          data?.hub === 'ok' ? (
            <Button
              variant="secondary"
              onClick={() => go({ panel: 'settings', post: undefined }, true)}
            >
              Настройки публикации
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 pb-2">
        <ChoiceChips
          label="Даты"
          choices={WINDOW_CHOICES}
          value={window}
          onChange={(value) => go({ window: value })}
        />
        {data && data.pages.length > 0 ? (
          <PagesStrip
            pages={data.pages}
            loginNeeded={data.login_needed}
            picked={search.page ?? null}
            onPick={(page) => go({ page })}
          />
        ) : null}
        <ChoiceChips
          label="Статус"
          choices={SEGMENTS.map((one) => ({ value: one.value, label: one.label }))}
          value={segment}
          onChange={(value) => {
            const target = SEGMENTS.find((one) => one.value === value)
            if (target) go({ status: target.status, window: target.window })
          }}
        />
        {data?.global_enabled === false ? (
          <p className="text-sm text-attention-ink">
            Общий выключатель публикаций выключен: ничего не публикуется ни на одной странице.
          </p>
        ) : null}
      </div>
      <RefreshStrip active={feed.isFetching && data !== undefined} />
      <div className="@container -mx-7 flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pt-2 pb-8">
        <QueryErrorLine query={feed} hasData={data !== undefined} />
        {feed.isPending ? <FeedSkeleton /> : null}
        {stateWords ? <EmptyState>{stateWords}</EmptyState> : null}
        {data && data.hub === 'ok' && days.length === 0 ? (
          <EmptyState>
            {search.status
              ? 'Таких публикаций за эти даты нет'
              : `Публикаций ${WINDOW_CHOICES.find((one) => one.value === window)?.label.toLowerCase() ?? ''} нет: черновики делают агенты и люди, здесь их утверждают`}
          </EmptyState>
        ) : null}
        {data?.capped ? (
          <p className="pb-2 text-sm text-attention-ink">
            Показаны первые 500. Сузьте даты или выберите страницу.
          </p>
        ) : null}
        {days.map((day) => (
          <DaySection key={day.date} day={day} openId={open} onOpen={(id) => go({ post: id })} />
        ))}
      </div>
    </FieldLayout>
  )
}

interface FeedEntry {
  key: string
  at: Instant
  row: PublicationRow | null
  manual: { text: string; mediaCount: number | null; page: string } | null
}

interface Day {
  date: string
  entries: FeedEntry[]
}

/** Лента по московским дням: посты Hub и посты, поставленные на площадке вручную. */
function byDay(
  rows: readonly PublicationRow[],
  pages: readonly PublicationPage[],
  page: string | undefined,
): Day[] {
  const entries: FeedEntry[] = rows.map((row) => ({
    key: `p${row.id}`,
    at: row.publish_at,
    row,
    manual: null,
  }))
  for (const one of pages) {
    if (page && one.hub_page !== page) continue
    for (const entry of one.queue?.manual ?? []) {
      if (!entry.publish_at) continue
      entries.push({
        key: `q${one.hub_page}:${entry.queue_id}`,
        at: entry.publish_at,
        row: null,
        manual: { text: entry.text, mediaCount: entry.media_count, page: one.label },
      })
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at))
  const days = new Map<string, FeedEntry[]>()
  for (const entry of entries) {
    const date = mskDate(entry.at)
    days.set(date, [...(days.get(date) ?? []), entry])
  }
  return [...days].map(([date, list]) => ({ date, entries: list }))
}

function DaySection({
  day,
  openId,
  onOpen,
}: {
  day: Day
  openId: number | null
  onOpen: (id: number) => void
}) {
  const today = useToday()
  return (
    <section aria-label={day.date}>
      <div className="flex h-11 items-end px-2 pb-2">
        <h2 className="flex items-baseline gap-2 text-lg">
          {formatDateWords(day.date, today)}
          <span className="font-normal text-ink-3 text-sm tabular-nums">
            {formatNumber(day.entries.length)}
          </span>
        </h2>
      </div>
      <ul className="-mx-2 flex flex-col">
        {day.entries.map(({ key, at, row, manual }) => (
          <li key={key}>
            {row ? (
              <PublicationLine
                row={row}
                selected={row.id === openId}
                onOpen={() => onOpen(row.id)}
              />
            ) : manual ? (
              <ManualLine at={at} manual={manual} />
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PublicationLine({
  row,
  selected,
  onOpen,
}: {
  row: PublicationRow
  selected: boolean
  onOpen: () => void
}) {
  const model = useCurrentModel()
  const status = statusWord(row.status, row.status_reason)
  const files = row.files.filter((file) => file.role === 'media').length
  return (
    <button
      type="button"
      data-selected={selected}
      onClick={onOpen}
      className={cn(
        'flex min-h-16 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-accent',
        selected && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <span className="w-12 shrink-0 text-base tabular-nums">{formatClock(row.publish_at)}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">{row.text || 'Без текста'}</span>
        <span className="truncate text-muted-foreground text-sm">
          {accountLabel(model.accounts, row.account ?? row.hub_page)} ·{' '}
          {KIND_WORDS[row.kind] ?? row.kind}, {filesWord(files)}
          {row.blocked ? ' · есть замечания' : ''}
        </span>
        {/* На телефоне состояние — третьей строкой: колонки нет. */}
        <span className="flex pt-0.5 @xl:hidden">
          <StatusWord sign={status.sign} className="max-w-full">
            {status.word}
            {row.price_mills !== null ? ` · ${formatMills(row.price_mills)}` : ''}
          </StatusWord>
        </span>
      </span>
      <span className="hidden w-20 shrink-0 text-right text-muted-foreground text-sm tabular-nums @xl:inline">
        {row.price_mills !== null ? formatMills(row.price_mills) : ''}
      </span>
      <span className="hidden w-44 shrink-0 @xl:flex">
        <StatusWord sign={status.sign} className="max-w-full">
          {status.word}
        </StatusWord>
      </span>
    </button>
  )
}

function ManualLine({ at, manual }: { at: Instant; manual: NonNullable<FeedEntry['manual']> }) {
  return (
    <div className="flex min-h-14 w-full min-w-0 items-center gap-3 px-2 py-2">
      <span className="w-12 shrink-0 text-base text-muted-foreground tabular-nums">
        {formatClock(at)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base text-muted-foreground">
          {manual.text || 'Без текста'}
        </span>
        <span className="truncate text-muted-foreground text-sm">
          {manual.page} · поставлен на площадке вручную
          {manual.mediaCount !== null ? `, ${filesWord(manual.mediaCount)}` : ''}
        </span>
      </span>
      <span className="hidden w-44 shrink-0 @xl:flex">
        <StatusWord className="max-w-full">В расписании площадки</StatusWord>
      </span>
    </div>
  )
}

/** Страницы модели: публикуют ли и как Hub последний раз прочёл их расписание. Нажатие — только эта страница. */
function PagesStrip({
  pages,
  loginNeeded,
  picked,
  onPick,
}: {
  pages: readonly PublicationPage[]
  loginNeeded: readonly string[]
  picked: string | null
  onPick: (page: string | undefined) => void
}) {
  return (
    <fieldset className="flex flex-wrap gap-2 border-0 p-0" aria-label="Страницы">
      {pages.map((page) => {
        const state = loginNeeded.includes(page.hub_page)
          ? { word: 'Нужен вход в Fansly', tone: 'bg-attention' }
          : pageState(page)
        const isPicked = picked === page.hub_page
        return (
          <button
            key={page.hub_page}
            type="button"
            aria-pressed={isPicked}
            onClick={() => onPick(isPicked ? undefined : page.hub_page)}
            title={isPicked ? 'Показать все страницы' : `Показать только ${page.label}`}
            className={cn(
              'flex h-9 items-center gap-2 rounded-full border border-input px-3 text-sm transition-colors duration-120 hover:bg-accent',
              isPicked && 'border-primary bg-primary-tint',
            )}
          >
            <span className={cn('size-2 rounded-full', state.tone)} aria-hidden />
            <span>{page.label}</span>
            <span className="text-muted-foreground">{state.word}</span>
          </button>
        )
      })}
    </fieldset>
  )
}

function pageState(page: PublicationPage): { word: string; tone: string } {
  if (page.stopped) return { word: 'Остановлена', tone: 'bg-destructive' }
  if (!page.enabled) return { word: 'Не публикует', tone: 'bg-ink-3' }
  if (page.queue && (page.queue.last_failure || !page.queue.complete || page.queue.stale)) {
    return { word: 'Расписание не прочитано', tone: 'bg-attention' }
  }
  return { word: 'Публикует', tone: 'bg-foreground' }
}

function FeedSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 pt-4">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="h-14 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  )
}
