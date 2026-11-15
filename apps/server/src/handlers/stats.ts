import type {
  StatsCommentPost,
  StatsMediaCard,
  StatsScreen,
} from '@contentops/contracts/domain/stats-screen'
import { type HubMediaHead, type HubStatsWindow, isHubError, type StatsDays } from '@contentops/hub'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { boundNames, failed, hubSlugOf, personOf } from './publications'

/**
 * «Статистика» (products plan §2.4, package C2): ContentOps' own screen over Hub's Fansly numbers of a model's page —
 * which media are watched, bought, commented. Read AS THE SIGNED-IN PERSON through Hub's person's door: the pages are
 * Hub's answer for the model's Hub slug (the reverse of `HUB_MODEL_MAP`, never `accounts.hub_page_ref`), Fansly ones
 * only — Fansly is where these numbers come from. Nothing is stored here.
 */

const DAY_MS = 86_400_000

function head(row: HubMediaHead) {
  return {
    media_offer_id: row.mediaOfferId,
    media_type: row.mediaType,
    duration_ms: row.durationMs,
    post_id: row.postId,
    posted_at: row.postedAt,
    deleted_at: row.deletedAt,
    caption: row.caption,
  }
}

function windowOf(window: HubStatsWindow) {
  return { from_day: window.fromDay, to_day: window.toDay, days: window.days }
}

/** The comments' window: the same UTC days as the media, not sliding hours. */
export function commentsWindow(window: HubStatsWindow): { from: string; to: string } {
  return {
    from: `${window.fromDay}T00:00:00.000Z`,
    to: new Date(Date.parse(`${window.toDay}T00:00:00.000Z`) + DAY_MS).toISOString(),
  }
}

export function statsHandlers(services: Services): HandlerRegistry {
  const { db } = services
  const slugOf = (model: ReturnType<typeof modelOf>) =>
    hubSlugOf(services.hubSignin?.setup.modelMap, model)

  /** The model's Fansly pages as Hub cuts them for the person, named as here when bound. */
  async function pagesOf(
    door: NonNullable<Services['personDoor']>,
    grant: string,
    model: ReturnType<typeof modelOf>,
  ) {
    const [settings, names] = await Promise.all([
      door.publicationSettings(grant, slugOf(model)),
      boundNames(db, model),
    ])
    return settings.pages
      .filter((page) => page.platform === 'fansly')
      .map((page) => ({
        hub_page: page.pageLabel,
        label: names.get(page.pageLabel)?.title ?? page.pageLabel,
      }))
  }

  return {
    stats: {
      screen: async ({ ctx, query }): Promise<StatsScreen> => {
        const model = modelOf(ctx.model)
        const empty = (hub: StatsScreen['hub']): StatsScreen => ({
          hub,
          pages: [],
          page: null,
          window: null,
          walk: null,
          media: [],
          top_sales: [],
          top_sales_total: 0,
          comments: { state: 'never_read', posts: [] },
          updated_at: null,
        })
        const person = await personOf(services, requireActor(ctx))
        if (person.state !== 'ok') return empty(person.state)
        const { door, grant } = person
        try {
          const pages = await pagesOf(door, grant, model)
          const page =
            pages.find((one) => one.hub_page === query.page)?.hub_page ?? pages[0]?.hub_page ?? null
          if (page === null) return { ...empty('ok'), pages }
          const content = await door.statsContent(grant, page, query.days as StatsDays)
          const comments = await door
            .contentComments(grant, page, commentsWindow(content.window))
            .catch((error: unknown) => {
              if (isHubError(error) && error.status === 401) failed(error)
              return null
            })
          const replies = comments?.repliesCoverage ?? []
          const posts: StatsCommentPost[] = (comments?.perPost ?? []).map((post) => ({
            post_ref: post.postRef,
            comment_count: post.commentCount,
            possibly_truncated_count: post.possiblyTruncatedCount,
            missing_count: post.missingCount,
            caption: post.caption,
            published_at: post.publishedAt,
          }))
          const state =
            comments === null
              ? 'failed'
              : posts.length === 0 &&
                  (replies.length === 0 || replies.every((row) => row.status === 'not_started'))
                ? 'never_read'
                : replies.some((row) => row.status === 'in_progress')
                  ? 'in_progress'
                  : 'ok'
          return {
            hub: 'ok',
            pages,
            page,
            window: windowOf(content.window),
            walk: content.walk,
            media: content.media.map((row) => ({
              ...head(row),
              views: row.views,
              for_you_views: row.forYouViews,
              timeline_views: row.timelineViews,
              other_views: row.otherViews,
              video_views: row.videoViews,
              completed_views: row.completedViews,
              watch_pct_sum: row.watchPctSum,
              likes: row.likes,
              all_time_views: row.allTimeViews,
            })),
            top_sales: content.topSales.map((row) => ({
              ...head(row),
              price_mills: row.priceMills,
              sales_count: row.salesCount,
              net_mills: row.netMills,
              gross_mills: row.grossMills,
              window_views: row.windowViews,
            })),
            top_sales_total: content.topSalesTotal,
            comments: { state, posts },
            updated_at: comments?.mediaUpdatedAt ?? null,
          }
        } catch (error) {
          return empty(failed(error))
        }
      },
      media: async ({ ctx, params, query }): Promise<StatsMediaCard> => {
        const model = modelOf(ctx.model)
        const person = await personOf(services, requireActor(ctx))
        if (person.state === 'no_hub')
          throw new ApiProblem('unavailable', 'Статистика ещё не подключена')
        if (person.state === 'no_grant')
          throw new ApiProblem(
            'forbidden',
            'Статистика открывается с учётной записью из реестра людей. Попросите владельца',
          )
        const { door, grant } = person
        if (!/^\d{1,30}$/.test(params.media)) throw new ApiProblem('not_found', 'Такого медиа нет')
        try {
          const pages = await pagesOf(door, grant, model)
          if (!query.page || !pages.some((one) => one.hub_page === query.page))
            throw new ApiProblem('not_found', 'Такой страницы нет')
          const card = await door.statsMedia(
            grant,
            query.page,
            params.media,
            query.days as StatsDays,
          )
          return {
            media_offer_id: card.mediaOfferId,
            window: windowOf(card.window),
            daily: card.daily,
            hourly: card.hourly,
            retention: card.retention.map((curve) => ({
              source: curve.source,
              sample_size: curve.sampleSize,
              points: curve.points.map((point) => ({
                percent: point.percent,
                still_watching: point.stillWatching,
              })),
            })),
            tags: card.tags,
          }
        } catch (error) {
          if (error instanceof ApiProblem || !isHubError(error)) throw error
          if (error.status === 404) throw new ApiProblem('not_found', 'Такого медиа нет')
          if (failed(error) === 'refused')
            throw new ApiProblem('forbidden', 'Эта страница вашей роли не открыта')
          throw new ApiProblem(
            'unavailable',
            'Статистика сейчас не загружается: обновите чуть позже',
          )
        }
      },
    },
  }
}
