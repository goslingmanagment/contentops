import { badShape, isRecord } from './http.ts'

/**
 * «Статистика» (package C2): Fansly's numbers of one page as Hub reads them, through the person's door
 * (`/api/v1/person/stats/*`). Fansly sends a row only for a day with activity; a missing number is `null`, never a zero
 * nobody measured.
 */

export type StatsDays = 7 | 30 | 90 | 180 | 365
export const STATS_DAYS: readonly StatsDays[] = [7, 30, 90, 180, 365]

export interface HubStatsWindow {
  fromDay: string
  toDay: string
  days: number
}

/** What names a media: its kind, length, post, dates and the post's text. */
export interface HubMediaHead {
  mediaOfferId: string
  mediaType: number | null
  durationMs: number | null
  postId: string | null
  postedAt: string | null
  deletedAt: string | null
  caption: string | null
}

export interface HubStatsMedia extends HubMediaHead {
  views: number | null
  forYouViews: number | null
  timelineViews: number | null
  otherViews: number | null
  videoViews: number | null
  completedViews: number | null
  watchMs: number | null
  watchPctSum: number | null
  likes: number | null
  allTimeViews: number | null
}

export interface HubStatsSold extends HubMediaHead {
  priceMills: number | null
  salesCount: number | null
  netMills: number | null
  /** Hub's own calculation (net ÷ 0.8), never summed with net. */
  grossMills: number | null
  windowViews: number | null
}

export interface HubStatsContent {
  window: HubStatsWindow
  walk: { visited: number; queued: number }
  media: HubStatsMedia[]
  topSales: HubStatsSold[]
  topSalesTotal: number
}

export interface HubStatsMediaCard {
  mediaOfferId: string
  window: HubStatsWindow
  daily: { day: string; source: number; views: number | null }[]
  hourly: { hour: string; source: number; views: number | null }[]
  retention: {
    source: number
    sampleSize: number | null
    points: { percent: number; stillWatching: number }[]
  }[]
  tags: { tag: string; source: number; views: number | null }[]
}

export interface HubCommentPost {
  postRef: string
  commentCount: number
  possiblyTruncatedCount: number
  missingCount: number
  caption: string | null
  publishedAt: string | null
}

export interface HubContentComments {
  perPost: HubCommentPost[]
  /** The replies' collection by Hub: `not_started`, `in_progress`, … per scope. */
  repliesCoverage: { status: string; newestCapturedAt: string | null }[]
  /** When Hub last read the page's media (the screen's «обновлено»). */
  mediaUpdatedAt: string | null
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

function windowOf(value: unknown, endpoint: string): HubStatsWindow {
  if (!isRecord(value) || typeof value.fromDay !== 'string' || typeof value.toDay !== 'string')
    throw badShape(endpoint, 'no window')
  return { fromDay: value.fromDay, toDay: value.toDay, days: num(value.days) ?? 0 }
}

function headOf(row: Record<string, unknown>): HubMediaHead {
  return {
    mediaOfferId: String(row.mediaOfferId ?? ''),
    mediaType: num(row.mediaType),
    durationMs: num(row.durationMs),
    postId: str(row.postId),
    postedAt: str(row.postedAt),
    deletedAt: str(row.deletedAt),
    caption: str(row.caption),
  }
}

export function parseStatsContent(json: unknown, endpoint: string): HubStatsContent {
  if (!isRecord(json) || !Array.isArray(json.media)) throw badShape(endpoint, 'no media')
  const walk = isRecord(json.walk) ? json.walk : {}
  return {
    window: windowOf(json.window, endpoint),
    walk: { visited: num(walk.visited) ?? 0, queued: num(walk.queued) ?? 0 },
    media: list(json.media).map((row) => ({
      ...headOf(row),
      views: num(row.views),
      forYouViews: num(row.forYouViews),
      timelineViews: num(row.timelineViews),
      otherViews: num(row.otherViews),
      videoViews: num(row.videoViews),
      completedViews: num(row.completedViews),
      watchMs: num(row.watchMs),
      watchPctSum: num(row.watchPctSum),
      likes: num(row.likes),
      allTimeViews: num(row.allTimeViews),
    })),
    topSales: list(json.topSales).map((row) => {
      const sales = isRecord(row.sales) ? row.sales : {}
      const gross = isRecord(sales.grossMills) ? num(sales.grossMills.value) : num(sales.grossMills)
      return {
        ...headOf(row),
        priceMills: num(row.priceMills),
        salesCount: num(sales.count),
        netMills: num(sales.netMills),
        grossMills: gross,
        windowViews: num(row.windowViews),
      }
    }),
    topSalesTotal: num(json.topSalesTotal) ?? 0,
  }
}

export function parseStatsMedia(json: unknown, endpoint: string): HubStatsMediaCard {
  if (!isRecord(json) || !Array.isArray(json.daily)) throw badShape(endpoint, 'no daily')
  return {
    mediaOfferId: String(json.mediaOfferId ?? ''),
    window: windowOf(json.window, endpoint),
    daily: list(json.daily).map((row) => ({
      day: String(row.day ?? ''),
      source: num(row.source) ?? 4,
      views: num(row.views),
    })),
    hourly: list(json.hourly).map((row) => ({
      hour: String(row.hour ?? ''),
      source: num(row.source) ?? 4,
      views: num(row.views),
    })),
    retention: list(json.retention).map((row) => ({
      source: num(row.source) ?? 4,
      sampleSize: num(row.sampleSize),
      points: list(row.points).flatMap((point) => {
        const percent = num(point.percent)
        const still = num(point.stillWatching)
        return percent === null || still === null ? [] : [{ percent, stillWatching: still }]
      }),
    })),
    tags: list(json.tags).map((row) => ({
      tag: String(row.tag ?? ''),
      source: num(row.source) ?? 4,
      views: num(row.views),
    })),
  }
}

export function parseContentComments(json: unknown, endpoint: string): HubContentComments {
  if (!isRecord(json) || !Array.isArray(json.perPost)) throw badShape(endpoint, 'no perPost')
  const coverage = list(json.coverage)
  const newest = coverage
    .filter((row) => row.plane === 'creator_stats_media')
    .flatMap((row) => {
      const at = str(row.updatedAt)
      return at ? [at] : []
    })
    .sort()
    .at(-1)
  return {
    perPost: list(json.perPost).map((row) => ({
      postRef: String(row.postRef ?? ''),
      commentCount: num(row.commentCount) ?? 0,
      possiblyTruncatedCount: num(row.possiblyTruncatedCount) ?? 0,
      missingCount: num(row.missingCount) ?? 0,
      caption: str(row.caption),
      publishedAt: str(row.publishedAt),
    })),
    repliesCoverage: coverage
      .filter((row) => row.plane === 'post_replies')
      .map((row) => ({
        status: String(row.status ?? ''),
        newestCapturedAt: str(row.newestCapturedAt),
      })),
    mediaUpdatedAt: newest ?? null,
  }
}
