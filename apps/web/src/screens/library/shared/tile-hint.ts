import {
  type Account,
  formatDate,
  formatNumber,
  type LocalDate,
  type PageSummaryEntry,
  type PlacementLevel,
  plural,
} from '@contentops/contracts'

/**
 * Что дописать к ID под плиткой (DESIGN §4.2): ответ по выбранной странице, когда включён
 * чип «Где залито» или сортировка по странице. Страница уже названа в чипе или в
 * сортировке, поэтому ответ короткий и не обрезается на плитке 176: «PPV-073 · Fansly 2
 * 08.08», «PPV-075 · не видели», у «Лучше зашёл на ▾» — число просмотров. На малой
 * плитке 120 — ещё короче: «08.08», «план» или «нет»; полный ответ со страницей — в
 * подсказке.
 */
export type TileHint = {
  kind: 'page' | 'views'
  account: Account
  /** Сегодня по Москве: дата другого года пишется с годом — «Fansly 2 22.09.2025». */
  today: LocalDate
}

/**
 * «Fansly 2 08.08». Дата другого года длиннее («22.09.2025»), и на плитке 176 страница
 * уступает ей место: страница уже названа в чипе, а целиком ответ — в подсказке.
 */
function pageText(hint: TileHint, summary: PageSummaryEntry | undefined, onTile: boolean): string {
  const { account, today } = hint
  if (summary && summary.placed_on.length > 0) {
    if (!summary.last_on) {
      return `${account.label} · ${summary.word}`
    }
    const date = formatDate(summary.last_on, today)
    const otherYear = summary.last_on.slice(0, 4) !== today.slice(0, 4)
    return onTile && otherYear ? date : `${account.label} ${date}`
  }
  return summary?.word ?? 'не видели'
}

function viewsText(summary: PageSummaryEntry | undefined): string {
  const views = summary?.views
  return views === null || views === undefined ? 'нет данных' : formatNumber(views)
}

/** «в плане» и «в планировщике»; «пропущено» — уже «нет». */
const PLANNED_LEVELS: ReadonlySet<PlacementLevel> = new Set<PlacementLevel>([
  'planned',
  'scheduled',
])

function compactText(hint: TileHint, summary: PageSummaryEntry | undefined): string {
  if (hint.kind === 'views') {
    const views = summary?.views
    return views === null || views === undefined ? 'нет' : formatNumber(views)
  }
  if (summary && summary.placed_on.length > 0) {
    return summary.last_on ? formatDate(summary.last_on, hint.today) : 'есть'
  }
  // После «FYP-0794 · » помещается четыре-пять букв: «в плане» и «в планировщике» —
  // «план» (среди незалитого это и есть разница), остальное — «нет». Слово целиком —
  // в подсказке.
  return summary && PLANNED_LEVELS.has(summary.level) ? 'план' : 'нет'
}

function summaryOf(hint: TileHint, summaries: readonly PageSummaryEntry[] | undefined) {
  return summaries?.find((entry) => entry.account === hint.account.code)
}

export function tileHintText(
  hint: TileHint,
  summaries: readonly PageSummaryEntry[] | undefined,
  compact = false,
): string {
  const summary = summaryOf(hint, summaries)
  if (compact) {
    return compactText(hint, summary)
  }
  return hint.kind === 'page' ? pageText(hint, summary, true) : viewsText(summary)
}

/** Подсказка к ответу: он же целиком и со страницей — «не видели на Fansly 2». */
export function tileHintTitle(
  hint: TileHint,
  summaries: readonly PageSummaryEntry[] | undefined,
): string {
  const summary = summaryOf(hint, summaries)
  const label = hint.account.label
  if (hint.kind === 'views') {
    const views = summary?.views
    return views === null || views === undefined
      ? `Просмотры на ${label}: нет данных`
      : `${formatNumber(views)} ${plural(views, ['просмотр', 'просмотра', 'просмотров'])} на ${label}`
  }
  const text = pageText(hint, summary, false)
  return summary && summary.placed_on.length > 0 ? text : `${text} на ${label}`
}
