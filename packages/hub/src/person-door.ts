import {
  type HubCustomOrderAnswer,
  type HubCustomOrderList,
  type HubOrderPart,
  type HubShootingStep,
  parseHubOrderAnswer,
  parseHubOrderList,
} from './custom-orders.ts'
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
  reason: string | null
}

export interface HubPublicationDetail {
  publication: HubPublication
  events: HubPublicationEvent[]
  approvedAt: string | null
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
                reason: typeof event.reason === 'string' ? event.reason : null,
              },
            ]
          })
        : []
      const revision = isRecord(raw.revision) ? raw.revision : null
      return {
        publication,
        events,
        approvedAt:
          revision && typeof revision.approvedAt === 'string' ? revision.approvedAt : null,
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
  }
}
