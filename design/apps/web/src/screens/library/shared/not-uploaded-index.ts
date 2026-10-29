import {
  type Account,
  type CatalogEntry,
  type ItemType,
  NOT_UPLOADED_TYPES,
  notUploadedStatus,
} from '@contentops/contracts'
import { type PageSummariesView, pageSummaryOf } from '@/data/catalog'

/**
 * Что ещё не залито на страницу (DESIGN §4.3) — прямо из индекса в браузере той же
 * функцией правила, что у сервера (`notUploadedStatus`): вкладки, чипы и папка на корне
 * без запроса. Поставленное в план на эту страницу не показывается и считается отдельно.
 */
export interface PageBacklog {
  /** По типам в порядке экрана: PPV, секстинги, лайф, сеты, фупы; новые первыми. */
  byType: ReadonlyMap<ItemType, readonly CatalogEntry[]>
  planned: readonly CatalogEntry[]
}

function newestFirst(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort(
    (left, right) =>
      right.arrived_on.localeCompare(left.arrived_on) || right.id.localeCompare(left.id),
  )
}

export function pageBacklog(
  items: readonly CatalogEntry[],
  summaries: PageSummariesView,
  account: Account,
): PageBacklog {
  const byType = new Map<ItemType, CatalogEntry[]>(NOT_UPLOADED_TYPES.map((type) => [type, []]))
  const planned: CatalogEntry[] = []
  for (const entry of newestFirst(items)) {
    const summary = pageSummaryOf(summaries, entry.id, account.code)
    const status = notUploadedStatus(entry, summary, account.platform)
    if (status === 'not_uploaded') {
      byType.get(entry.type)?.push(entry)
    } else if (status === 'in_plan') {
      planned.push(entry)
    }
  }
  return { byType, planned }
}

/** Незалитое без фупов, новые первыми: число вкладки и папки на корне. */
export function backlogWithoutFyp(backlog: PageBacklog): CatalogEntry[] {
  return newestFirst(
    [...backlog.byType].flatMap(([type, entries]) => (type === 'fyp' ? [] : entries)),
  )
}

export interface PageNotUploaded {
  account: Account
  /** Незалитое без фупов, новые первыми. */
  items: CatalogEntry[]
}

/** «Ещё не залито» всех страниц для папки на корне Библиотеки (DESIGN §4.1). */
export function notUploadedByPage(
  items: readonly CatalogEntry[],
  summaries: PageSummariesView,
  accounts: readonly Account[],
): PageNotUploaded[] {
  return accounts.map((account) => ({
    account,
    items: backlogWithoutFyp(pageBacklog(items, summaries, account)),
  }))
}
