import {
  type HubContentComments,
  type HubStatsContent,
  type HubStatsMediaCard,
  parseContentComments,
  parseStatsContent,
  parseStatsMedia,
  type StatsDays,
} from './creator-stats.ts'
import {
  type HubCustomOrderAnswer,
  type HubCustomOrderList,
  type HubOrderPart,
  type HubShootingStep,
  parseHubOrderAnswer,
  parseHubOrderList,
} from './custom-orders.ts'
import { isHubError } from './errors.ts'
import { badShape, callJson, type HttpContext, isRecord } from './http.ts'
import {
  type ApproveResult,
  type HubPublication,
  parseApproveResults,
  parsePublication,
} from './publications.ts'

/**
 * Hub's person's door (Hub `services/person-door.ts`, package C3): ContentOps acts in Hub AS THE
 * SIGNED-IN PERSON — its sign-in key (`signin:contentops`) and the person's live grant — so Hub's
 * rights and the test realm's wall are the person's own, never ContentOps' key's. A grant that is
 * over answers 401 (`grant_inactive`): ContentOps ends its own session. One client for every row of the
 * door: «Съёмка»'s (C3) and «Публикации»'s and «Статистика»'s (C2).
 */

export interface PersonDoorOptions {
  /** Hub's console: `https://hub.example`. */
  baseUrl: string
  /** ContentOps' sign-in key (`signin:contentops`). Never logged. */
  key: string
  /** The client's name at Hub: `contentops`. */
  client: string
  fetch?: typeof fetch
  /** Per-request limit (default 15 s): a person waits for it. */
  timeoutMs?: number
  now?: () => Date
}

export interface PersonShootingStep {
  code: string
  step: HubShootingStep
  deadlineOn?: string
  note?: string
  part?: HubOrderPart
}

/** A post's journal line, as Hub keeps it. */
export interface HubPublicationEvent {
  at: string
  fromStatus: string | null
  toStatus: string
  actorKind: 'human' | 'agent' | 'hub'
  /** Who moved it, by name (a person's registry name, an agent key's name); null when Hub did or did not say. */
  actorName: string | null
  reason: string | null
}

export interface HubPublicationDetail {
  publication: HubPublication
  events: HubPublicationEvent[]
  approvedAt: string | null
  /** Who drafted it and who approved it, by name; null when Hub does not say (an older Hub, a login with no person). */
  authorName: string | null
  approvedByName: string | null
}

/** Where a post of a page goes: its Fansly walls and subscription tiers by name, no prices. */
export interface HubPublicationTargets {
  walls: { wallRef: string; name: string | null; defaultWall: boolean }[]
  tiers: { tierRef: string; name: string | null }[]
}

/** A page's publishing settings, as Hub says them (no prices of anything but the paid range). */
export interface HubPublicationSettings {
  pageLabel: string
  platform: string
  enabled: boolean
  autostopReason: string | null
  paidPriceMinMills: number | null
  paidPriceMaxMills: number | null
  repostThresholdDays: number
  dailyLimit: number | null
}

/** A page's schedule on the platform as Hub last read it. */
export interface HubPublicationQueue {
  pageLabel: string
  platform: string
  readAt: string | null
  complete: boolean
  stale: boolean
  refreshRequestedAt: string | null
  lastFailure: string | null
  entries: {
    queueId: string
    publishAt: string | null
    text: string
    mediaCount: number | null
    publicationId: number | null
  }[]
}

/** One withdrawal's or deletion's outcome, as Hub answers it. */
export interface HubWithdrawResult {
  id: number
  outcome: string
  reason: string | null
  publication: HubPublication | null
}

/** One switch or limit of publishing: its value as Hub holds it, and the version to set it by. */
export interface HubSwitch {
  key: string
  value: string | number | boolean | null
  version: number | null
  /** A secret (the OnlyFans API key): only whether it is set. */
  isSet: boolean | null
}

function parseWithdraw(json: unknown, endpoint: string): HubWithdrawResult[] {
  if (!isRecord(json) || !Array.isArray(json.results)) throw badShape(endpoint, 'no results')
  return json.results.flatMap((one) => {
    if (!isRecord(one) || typeof one.id !== 'number' || typeof one.outcome !== 'string') return []
    return [
      {
        id: one.id,
        outcome: one.outcome,
        reason: typeof one.reason === 'string' ? one.reason : null,
        publication: one.publication == null ? null : parsePublication(one.publication, endpoint),
      },
    ]
  })
}

export interface PublicationListQuery {
  pageLabel?: string
  modelSlug?: string
  status?: string
  from?: string
  to?: string
  limit?: number
}

export interface PersonDoor {
  /** The open custom orders of the person's shooting (their scope and realm, by Hub). */
  customOrders(grant: string, signal?: AbortSignal): Promise<HubCustomOrderList>
  /** A shooting step as the person; Hub refuses whoever does not lead it (409 `not_allowed`). */
  customOrderStep(
    grant: string,
    body: PersonShootingStep,
    signal?: AbortSignal,
  ): Promise<HubCustomOrderAnswer>
  /** «Публикации»: the person's publications (a page, a model, a status, a window). */
  publicationList(
    grant: string,
    query: PublicationListQuery,
    signal?: AbortSignal,
  ): Promise<HubPublication[]>
  /** One publication with its journal; 404 — not the person's or not there. */
  publicationGet(grant: string, id: number, signal?: AbortSignal): Promise<HubPublicationDetail>
  /** The page's walls and tiers by name (no prices); null when this Hub has no such row yet. */
  publicationTargets(
    grant: string,
    pageLabel: string,
    signal?: AbortSignal,
  ): Promise<HubPublicationTargets | null>
  /** The global switch and the person's pages' settings. */
  publicationSettings(
    grant: string,
    modelSlug?: string,
    signal?: AbortSignal,
  ): Promise<{ globalEnabled: boolean; pages: HubPublicationSettings[] }>
  /** The platforms' schedules of the person's pages (one model's, with `modelSlug`). */
  publicationQueues(
    grant: string,
    modelSlug?: string,
    signal?: AbortSignal,
  ): Promise<HubPublicationQueue[]>
  /** Approve drafts as the person (each checked again by Hub). */
  publicationApprove(
    grant: string,
    items: { id: number; version: number }[],
    signal?: AbortSignal,
  ): Promise<ApproveResult[]>
  /** «Отменить публикацию» before Hub hands it to the platform. */
  publicationCancel(grant: string, id: number, signal?: AbortSignal): Promise<HubPublication>
  /** «Убрать из расписания»: sent once by Hub; its own outcome (`refused` with Hub's words, too). */
  publicationWithdraw(grant: string, id: number, signal?: AbortSignal): Promise<HubWithdrawResult[]>
  /** «Заменить»: a new draft of a withdrawn post. */
  publicationReplace(grant: string, id: number, signal?: AbortSignal): Promise<HubPublication>
  /** «Проверить»: the person's answer to an unknown outcome. */
  publicationResolve(
    grant: string,
    id: number,
    answer:
      | { outcome: 'went_out'; state?: 'scheduled' | 'published'; platformPostRef?: string }
      | { outcome: 'did_not_go_out' },
    signal?: AbortSignal,
  ): Promise<{ publication: HubPublication; replacementId: number | null }>
  /** «Прочитать расписание заново» of a page. */
  publicationQueueRefresh(grant: string, pageLabel: string, signal?: AbortSignal): Promise<void>
  /** The owner's: a page's publishing settings. */
  publicationSettingsUpdate(
    grant: string,
    pageLabel: string,
    settings: Omit<HubPublicationSettings, 'pageLabel' | 'platform' | 'autostopReason'>,
    signal?: AbortSignal,
  ): Promise<void>
  /** The owner's: «Удалить со стены». */
  publicationDeletePost(
    grant: string,
    id: number,
    signal?: AbortSignal,
  ): Promise<HubWithdrawResult[]>
  /** The owner's: «Убрать из расписания всё, что поставил Hub». */
  publicationWithdrawPage(
    grant: string,
    pageLabel: string,
    signal?: AbortSignal,
  ): Promise<HubWithdrawResult[]>
  /** The publishing switches and limits (read: the owner and a content manager). */
  publicationSwitches(grant: string, signal?: AbortSignal): Promise<HubSwitch[]>
  /** The owner's: set switches and limits of publishing. */
  publicationSwitchSet(
    grant: string,
    patches: { key: string; value: string | number | boolean; expectedVersion?: number }[],
    signal?: AbortSignal,
  ): Promise<void>
  /** The owner's: the Fansly pages that need a login. */
  fanslyLoginPages(grant: string, signal?: AbortSignal): Promise<string[]>
  /** «Статистика»: the page's media over the last `days` UTC days and what sells (all time). */
  statsContent(
    grant: string,
    pageLabel: string,
    days: StatsDays,
    signal?: AbortSignal,
  ): Promise<HubStatsContent>
  /** «Статистика»: one media's days by surface, first hours, retention and tags. */
  statsMedia(
    grant: string,
    pageLabel: string,
    mediaOfferId: string,
    days: StatsDays,
    signal?: AbortSignal,
  ): Promise<HubStatsMediaCard>
  /** «Статистика»: the comments of the page's posts between two instants, by post. */
  contentComments(
    grant: string,
    pageLabel: string,
    window: { from: string; to: string },
    signal?: AbortSignal,
  ): Promise<HubContentComments>
}

export function createPersonDoor(options: PersonDoorOptions): PersonDoor {
  const ctx: HttpContext = {
    baseUrl: options.baseUrl,
    key: options.key,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
    now: options.now ?? (() => new Date()),
  }
  const client = options.client
  return {
    async customOrders(grant, signal) {
      const endpoint = 'person.custom-orders'
      return parseHubOrderList(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/custom-orders/list',
          json: { client, grant },
          signal,
        }),
        endpoint,
      )
    },
    async customOrderStep(grant, body, signal) {
      const endpoint = 'person.custom-orders.step'
      return parseHubOrderAnswer(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/custom-orders/step',
          json: { client, grant, ...body },
          signal,
        }),
        endpoint,
      )
    },
    async publicationList(grant, query, signal) {
      const endpoint = 'person.publications.list'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/list',
        json: { client, grant, ...query },
        signal,
      })
      if (!isRecord(json) || !Array.isArray(json.publications))
        throw badShape(endpoint, 'no publications')
      return json.publications.map((one) => parsePublication(one, endpoint))
    },
    async publicationGet(grant, id, signal) {
      const endpoint = 'person.publications.get'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/get',
        json: { client, grant, id },
        signal,
      })
      const publication = parsePublication(json, endpoint)
      const raw = publication.raw
      // Who, by name (Hub with the names): id → name; an older Hub has none, and the card says «человек» / «агент».
      const namesOf = (list: unknown) =>
        new Map(
          (Array.isArray(list) ? list : []).flatMap((one) =>
            isRecord(one) && typeof one.id === 'number' && typeof one.name === 'string'
              ? [[one.id, one.name] as const]
              : [],
          ),
        )
      const names = isRecord(raw.names) ? raw.names : {}
      const users = namesOf(names.users)
      const agentKeys = namesOf(names.agentKeys)
      const nameOf = (userId: unknown, agentKeyId: unknown) =>
        (typeof userId === 'number' ? users.get(userId) : undefined) ??
        (typeof agentKeyId === 'number' ? agentKeys.get(agentKeyId) : undefined) ??
        null
      const events: HubPublicationEvent[] = Array.isArray(raw.events)
        ? raw.events.flatMap((event) => {
            if (
              !isRecord(event) ||
              typeof event.toStatus !== 'string' ||
              typeof event.at !== 'string'
            )
              return []
            const actor = isRecord(event.actor) ? event.actor.kind : event.actorKind
            return [
              {
                at: event.at,
                fromStatus: typeof event.fromStatus === 'string' ? event.fromStatus : null,
                toStatus: event.toStatus,
                actorKind: actor === 'human' || actor === 'agent' ? actor : 'hub',
                actorName: nameOf(event.actorUserId, event.actorAgentKeyId),
                reason: typeof event.reason === 'string' ? event.reason : null,
              },
            ]
          })
        : []
      const revision = isRecord(raw.revision) ? raw.revision : null
      const author = isRecord(raw.author) ? raw.author : {}
      return {
        publication,
        events,
        approvedAt:
          revision && typeof revision.approvedAt === 'string' ? revision.approvedAt : null,
        authorName: nameOf(author.userId, author.agentKeyId),
        approvedByName: revision ? nameOf(revision.approvedByUserId, null) : null,
      }
    },
    async publicationTargets(grant, pageLabel, signal) {
      const endpoint = 'person.publications.targets'
      let json: unknown
      try {
        json = await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/targets',
          json: { client, grant, pageLabel },
          signal,
        })
      } catch (error) {
        // A Hub without the row answers 404 (or refuses the unknown operation): the card goes without the names.
        if (isHubError(error) && (error.status === 404 || error.status === 403)) return null
        throw error
      }
      if (!isRecord(json) || !Array.isArray(json.walls) || !Array.isArray(json.tiers))
        throw badShape(endpoint, 'no walls or tiers')
      return {
        walls: json.walls.flatMap((one) =>
          isRecord(one) && typeof one.wallRef === 'string'
            ? [
                {
                  wallRef: one.wallRef,
                  name: typeof one.name === 'string' ? one.name : null,
                  defaultWall: one.defaultWall === true,
                },
              ]
            : [],
        ),
        tiers: json.tiers.flatMap((one) =>
          isRecord(one) && typeof one.tierRef === 'string'
            ? [{ tierRef: one.tierRef, name: typeof one.name === 'string' ? one.name : null }]
            : [],
        ),
      }
    },
    async publicationSettings(grant, modelSlug, signal) {
      const endpoint = 'person.publications.settings'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/settings',
        json: { client, grant, ...(modelSlug ? { modelSlug } : {}) },
        signal,
      })
      if (!isRecord(json) || !Array.isArray(json.pages)) throw badShape(endpoint, 'no pages')
      return {
        globalEnabled: json.globalEnabled === true,
        pages: json.pages.flatMap((page) => {
          if (!isRecord(page) || typeof page.pageLabel !== 'string') return []
          const num = (value: unknown) => (typeof value === 'number' ? value : null)
          return [
            {
              pageLabel: page.pageLabel,
              platform: typeof page.platform === 'string' ? page.platform : '',
              enabled: page.enabled === true,
              autostopReason: typeof page.autostopReason === 'string' ? page.autostopReason : null,
              paidPriceMinMills: num(page.paidPriceMinMills),
              paidPriceMaxMills: num(page.paidPriceMaxMills),
              repostThresholdDays: num(page.repostThresholdDays) ?? 0,
              dailyLimit: num(page.dailyLimit),
            },
          ]
        }),
      }
    },
    async publicationQueues(grant, modelSlug, signal) {
      const endpoint = 'person.publications.queue'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/queue',
        json: { client, grant, ...(modelSlug ? { modelSlug } : {}) },
        signal,
      })
      if (!isRecord(json) || !Array.isArray(json.pages)) throw badShape(endpoint, 'no pages')
      const text = (value: unknown) => (typeof value === 'string' ? value : null)
      return json.pages.flatMap((page) => {
        if (!isRecord(page) || typeof page.pageLabel !== 'string') return []
        return [
          {
            pageLabel: page.pageLabel,
            platform: text(page.platform) ?? '',
            readAt: text(page.readAt),
            complete: page.complete === true,
            stale: page.stale === true,
            refreshRequestedAt: text(page.refreshRequestedAt),
            lastFailure: text(page.lastFailure),
            entries: (Array.isArray(page.entries) ? page.entries : []).flatMap((entry) =>
              isRecord(entry) && typeof entry.queueId === 'string'
                ? [
                    {
                      queueId: entry.queueId,
                      publishAt: text(entry.publishAt),
                      text: text(entry.text) ?? '',
                      mediaCount: typeof entry.mediaCount === 'number' ? entry.mediaCount : null,
                      publicationId:
                        typeof entry.publicationId === 'number' ? entry.publicationId : null,
                    },
                  ]
                : [],
            ),
          },
        ]
      })
    },
    async publicationCancel(grant, id, signal) {
      const endpoint = 'person.publications.cancel'
      return parsePublication(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/cancel',
          json: { client, grant, id },
          signal,
        }),
        endpoint,
      )
    },
    async publicationWithdraw(grant, id, signal) {
      const endpoint = 'person.publications.withdraw'
      return parseWithdraw(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/withdraw',
          json: { client, grant, id },
          signal,
        }),
        endpoint,
      )
    },
    async publicationReplace(grant, id, signal) {
      const endpoint = 'person.publications.replace'
      return parsePublication(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/replace',
          json: { client, grant, id },
          signal,
        }),
        endpoint,
      )
    },
    async publicationResolve(grant, id, answer, signal) {
      const endpoint = 'person.publications.resolve'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/resolve',
        json: { client, grant, id, answer },
        signal,
      })
      if (!isRecord(json)) throw badShape(endpoint, 'not an object')
      const replacement =
        isRecord(json.replacement) && typeof json.replacement.id === 'number'
          ? json.replacement.id
          : null
      return {
        publication: parsePublication(json.publication, endpoint),
        replacementId: replacement,
      }
    },
    async publicationQueueRefresh(grant, pageLabel, signal) {
      await callJson(ctx, 'person.publications.queue.refresh', {
        method: 'POST',
        path: 'api/v1/person/publications/queue/refresh',
        json: { client, grant, pageLabel },
        signal,
      })
    },
    async publicationSettingsUpdate(grant, pageLabel, settings, signal) {
      await callJson(ctx, 'person.publications.settings.update', {
        method: 'POST',
        path: 'api/v1/person/publications/settings/update',
        json: { client, grant, pageLabel, settings },
        signal,
      })
    },
    async publicationDeletePost(grant, id, signal) {
      const endpoint = 'person.publications.delete-post'
      return parseWithdraw(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/delete-post',
          json: { client, grant, id },
          signal,
        }),
        endpoint,
      )
    },
    async publicationWithdrawPage(grant, pageLabel, signal) {
      const endpoint = 'person.publications.withdraw-page'
      return parseWithdraw(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/withdraw-page',
          json: { client, grant, pageLabel },
          signal,
        }),
        endpoint,
      )
    },
    async publicationSwitches(grant, signal) {
      const endpoint = 'person.publications.switches'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/publications/switches',
        json: { client, grant },
        signal,
      })
      if (!isRecord(json) || !Array.isArray(json.subsystems))
        throw badShape(endpoint, 'no subsystems')
      return json.subsystems.flatMap((subsystem) =>
        isRecord(subsystem) && Array.isArray(subsystem.items)
          ? subsystem.items.flatMap((item): HubSwitch[] => {
              if (!isRecord(item) || typeof item.key !== 'string') return []
              // Hub's view of a key (its config screen's rule `seedValue`): the override, else a running value,
              // else the default; a secret says only whether it is set.
              const running = Array.isArray(item.running)
                ? item.running.find(
                    (one) => isRecord(one) && one.state !== 'unknown' && one.masked !== true,
                  )
                : undefined
              const raw =
                item.desired ??
                (isRecord(running) ? running.value : undefined) ??
                item.default ??
                null
              const secret = item.secret === true
              const states = Array.isArray(item.running)
                ? item.running.flatMap((one) =>
                    isRecord(one) && typeof one.state === 'string' ? [one.state] : [],
                  )
                : []
              return [
                {
                  key: item.key,
                  value: secret
                    ? null
                    : typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
                      ? raw
                      : null,
                  version: typeof item.overrideVersion === 'number' ? item.overrideVersion : null,
                  isSet: secret
                    ? states.length > 0 && states.every((state) => state === 'set')
                    : null,
                },
              ]
            })
          : [],
      )
    },
    async publicationSwitchSet(grant, patches, signal) {
      await callJson(ctx, 'person.publications.switches.set', {
        method: 'POST',
        path: 'api/v1/person/publications/switches/set',
        json: { client, grant, patches },
        signal,
      })
    },
    async fanslyLoginPages(grant, signal) {
      const endpoint = 'person.fansly.login-pages'
      const json = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/person/fansly/login-pages',
        json: { client, grant },
        signal,
      })
      if (!isRecord(json) || !Array.isArray(json.pages)) throw badShape(endpoint, 'no pages')
      return json.pages.filter((one): one is string => typeof one === 'string')
    },
    async publicationApprove(grant, items, signal) {
      const endpoint = 'person.publications.approve'
      return parseApproveResults(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/publications/approve',
          json: { client, grant, items },
          signal,
        }),
        endpoint,
      )
    },
    async statsContent(grant, pageLabel, days, signal) {
      const endpoint = 'person.stats.content'
      return parseStatsContent(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/stats/content',
          json: { client, grant, pageLabel, days },
          signal,
        }),
        endpoint,
      )
    },
    async statsMedia(grant, pageLabel, mediaOfferId, days, signal) {
      const endpoint = 'person.stats.media'
      return parseStatsMedia(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/stats/media',
          json: { client, grant, pageLabel, mediaOfferId, days },
          signal,
        }),
        endpoint,
      )
    },
    async contentComments(grant, pageLabel, window, signal) {
      const endpoint = 'person.stats.comments'
      return parseContentComments(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/stats/comments',
          json: { client, grant, pageLabel, from: window.from, to: window.to },
          signal,
        }),
        endpoint,
      )
    },
  }
}
