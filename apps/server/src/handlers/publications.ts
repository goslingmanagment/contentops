import type {
  PublicationCard,
  PublicationPage,
  PublicationRow,
  PublicationsFeed,
  PublicationWindow,
} from '@contentops/contracts/domain/publications-screen'
import type { Queryable } from '@contentops/db'
import { type HubPublication, isHubError, type PersonDoor } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { grantOf } from '../hub-orders/steps'
import type { Services } from '../services'

/**
 * «Публикации» (products plan §2.4, package C2): ContentOps' own screen over Hub's publications. Read AS THE
 * SIGNED-IN PERSON through Hub's person's door with the person's grant (their session's `hub_grant`), so Hub alone
 * decides what they see: the owner every page, a content manager the pages of her models. The screen is a model's: it
 * asks Hub FOR THE MODEL by Hub's slug (the reverse of `HUB_MODEL_MAP`) and takes the pages, posts and schedules as
 * Hub cuts them — never through `accounts.hub_page_ref`, which the test model binds to nothing on purpose (its
 * background jobs never ask Hub for a test page). A page bound here lends its name; one that is not shows Hub's.
 * ContentOps adds the plan's row a post was prepared from and keeps nothing of Hub's answer.
 */

const DAY_MS = 86_400_000
const LIST_LIMIT = 500
/** «Не вышли»: what did not go out, by Hub's words. */
const NOT_OUT = ['not_published', 'rejected', 'missed'] as const

/** The window's bounds by Moscow's days (the agency's clock): `from` inclusive, `to` exclusive. */
export function windowOf(window: PublicationWindow, now: Date): { from?: string; to?: string } {
  const moscow = new Date(now.getTime() + 3 * 3_600_000)
  const today =
    Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate()) - 3 * 3_600_000
  const at = (days: number) => new Date(today + days * DAY_MS).toISOString()
  switch (window) {
    case 'next7':
      return { from: at(0), to: at(7) }
    case 'next30':
      return { from: at(0), to: at(30) }
    case 'last7':
      return { from: at(-6), to: at(1) }
    case 'last30':
      return { from: at(-29), to: at(1) }
    case 'all':
      return {}
  }
}

/** Hub's slug of a model here (the reverse of `HUB_MODEL_MAP`; the same code where it is not named). */
export function hubSlugOf(
  modelMap: Readonly<Record<string, string>> | undefined,
  model: Pick<ModelScope, 'code'>,
): string {
  return Object.entries(modelMap ?? {}).find(([, code]) => code === model.code)?.[0] ?? model.code
}

/** The model's pages bound to Hub pages here, for their names only: Hub's answer decides what is shown. */
async function boundNames(
  q: Queryable,
  model: ModelScope,
): Promise<Map<string, { code: string; title: string }>> {
  const { rows } = await q.execute<{ code: string; title: string; hub_page_ref: string }>(sql`
    SELECT code, title, hub_page_ref FROM accounts
     WHERE model_id = ${model.id}::uuid AND hub_page_ref IS NOT NULL AND archived_at IS NULL`)
  return new Map(rows.map((row) => [row.hub_page_ref, { code: row.code, title: row.title }]))
}

async function planRows(
  q: Queryable,
  ids: readonly number[],
): Promise<Map<number, { id: string; date: string }>> {
  if (ids.length === 0) return new Map()
  const { rows } = await q.execute<{
    id: string
    slot_date: string
    hub_publication_id: string
  }>(sql`
    SELECT id, to_char(slot_date, 'YYYY-MM-DD') AS slot_date, hub_publication_id::text AS hub_publication_id
      FROM posting_plan_rows WHERE hub_publication_id = ANY(${`{${ids.join(',')}}`}::bigint[])`)
  return new Map(
    rows.map((row) => [Number(row.hub_publication_id), { id: row.id, date: row.slot_date }]),
  )
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function rowOf(
  publication: HubPublication,
  accountOf: ReadonlyMap<string, string>,
  plan: ReadonlyMap<number, { id: string; date: string }>,
): PublicationRow {
  const raw = publication.raw
  const media = Array.isArray(raw.media) ? raw.media : []
  const author =
    typeof raw.author === 'object' && raw.author !== null
      ? (raw.author as { kind?: unknown }).kind
      : null
  const command = (value: unknown) =>
    typeof value === 'object' && value !== null ? text((value as { state?: unknown }).state) : null
  return {
    id: publication.id,
    hub_page: publication.pageLabel ?? '',
    account: accountOf.get(publication.pageLabel ?? '') ?? null,
    platform: publication.platform ?? '',
    kind: publication.kind ?? '',
    status: publication.status,
    version: publication.version,
    text: text(raw.text) ?? '',
    publish_at: publication.publishAt ?? publication.updatedAt,
    expires_at: text(raw.expiresAt),
    price_mills: typeof raw.priceMills === 'number' ? raw.priceMills : null,
    files: media.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const one = item as Record<string, unknown>
      return [
        {
          position: typeof one.position === 'number' ? one.position : 0,
          role: one.role === 'preview' ? ('preview' as const) : ('media' as const),
          source: one.source === 'file' ? ('file' as const) : ('vault' as const),
          name:
            text(one.name) ??
            text(one.mediaRef) ??
            (typeof one.fileId === 'number' ? `файл ${one.fileId}` : null),
        },
      ]
    }),
    findings: publication.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
    })),
    blocked: publication.blocked,
    author: author === 'human' || author === 'agent' ? author : 'hub',
    platform_post_ref: publication.platformPostRef,
    status_reason: publication.statusReason,
    withdrawal: command(raw.withdrawal),
    deletion: command(raw.deletion),
    status_changed_at: publication.statusChangedAt ?? publication.updatedAt,
    plan_row: plan.get(publication.id) ?? null,
  }
}

/** Why there is no answer, as the screen says it; a door that refused the person is `refused`. */
function failed(error: unknown): 'unreachable' | 'refused' {
  if (!isHubError(error)) throw error
  if (error.status === 401)
    throw new ApiProblem('unauthenticated', 'Вход закончился: войдите снова')
  return error.status === 403 ? 'refused' : 'unreachable'
}

async function personOf(services: Services, actor: ReturnType<typeof requireActor>) {
  const door: PersonDoor | null = services.personDoor ?? null
  if (!door) return { door: null, grant: null, state: 'no_hub' as const }
  const grant = await grantOf(services.db, actor)
  if (!grant) return { door, grant: null, state: 'no_grant' as const }
  return { door, grant, state: 'ok' as const }
}

export function publicationsHandlers(services: Services): HandlerRegistry {
  const { db } = services
  const slugOf = (model: ModelScope) => hubSlugOf(services.hubSignin?.setup.modelMap, model)
  return {
    publications: {
      feed: async ({ ctx, query }): Promise<PublicationsFeed> => {
        const actor = requireActor(ctx)
        const model = modelOf(ctx.model)
        const now = new Date()
        const empty = (hub: PublicationsFeed['hub']): PublicationsFeed => ({
          hub,
          read_at: now.toISOString(),
          global_enabled: null,
          pages: [],
          publications: [],
          capped: false,
        })
        const person = await personOf(services, actor)
        if (person.state !== 'ok') return empty(person.state)
        const names = await boundNames(db, model)
        const accountOf = new Map([...names].map(([hubPage, bound]) => [hubPage, bound.code]))
        const slug = slugOf(model)
        try {
          // The model's pages as Hub cuts them for the person: a page asked for must be one of them.
          const [settings, queues] = await Promise.all([
            person.door.publicationSettings(person.grant, slug),
            person.door.publicationQueues(person.grant, slug),
          ])
          const ours = new Set(settings.pages.map((page) => page.pageLabel))
          const page = query.page && ours.has(query.page) ? query.page : undefined
          const base = {
            ...(page ? { pageLabel: page } : {}),
            modelSlug: slug,
            ...windowOf(query.window, now),
            limit: LIST_LIMIT,
          }
          const statuses = query.status === 'not_out' ? [...NOT_OUT] : [query.status]
          const lists = await Promise.all(
            statuses.map((status) =>
              person.door.publicationList(person.grant, status ? { ...base, status } : base),
            ),
          )
          const publications = lists
            .flat()
            .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? '') || a.id - b.id)
          const plan = await planRows(
            db,
            publications.map((one) => one.id),
          )
          const queueOf = new Map(queues.map((queue) => [queue.pageLabel, queue]))
          const shown: PublicationPage[] = settings.pages.map((set) => {
            const queue = queueOf.get(set.pageLabel)
            const bound = names.get(set.pageLabel)
            return {
              hub_page: set.pageLabel,
              account: bound?.code ?? null,
              label: bound?.title ?? set.pageLabel,
              platform: set.platform,
              enabled: set.enabled,
              stopped: set.autostopReason,
              paid_price_min_mills: set.paidPriceMinMills,
              paid_price_max_mills: set.paidPriceMaxMills,
              repost_threshold_days: set.repostThresholdDays,
              daily_limit: set.dailyLimit,
              queue: queue
                ? {
                    read_at: queue.readAt,
                    complete: queue.complete,
                    stale: queue.stale,
                    refresh_requested_at: queue.refreshRequestedAt,
                    last_failure: queue.lastFailure,
                    manual: queue.entries
                      .filter((entry) => entry.publicationId === null)
                      .map((entry) => ({
                        queue_id: entry.queueId,
                        publish_at: entry.publishAt,
                        text: entry.text,
                        media_count: entry.mediaCount,
                      })),
                  }
                : null,
            }
          })
          return {
            hub: 'ok',
            read_at: now.toISOString(),
            global_enabled: settings.globalEnabled,
            pages: shown,
            publications: publications.map((one) => rowOf(one, accountOf, plan)),
            capped: lists.some((list) => list.length >= LIST_LIMIT),
          }
        } catch (error) {
          return empty(failed(error))
        }
      },

      card: async ({ ctx, params }): Promise<PublicationCard> => {
        const actor = requireActor(ctx)
        const model = modelOf(ctx.model)
        const id = Number(params.publication)
        if (!Number.isInteger(id) || id <= 0)
          throw new ApiProblem('not_found', 'Такой публикации нет')
        const person = await personOf(services, actor)
        if (person.state !== 'ok')
          return { hub: person.state, publication: null, events: [], approved_at: null }
        const names = await boundNames(db, model)
        const accountOf = new Map([...names].map(([hubPage, bound]) => [hubPage, bound.code]))
        try {
          const [detail, settings] = await Promise.all([
            person.door.publicationGet(person.grant, id),
            person.door.publicationSettings(person.grant, slugOf(model)),
          ])
          // A post of another model's page is not this model's: the same 404 as one that is not there.
          if (!settings.pages.some((page) => page.pageLabel === detail.publication.pageLabel)) {
            throw new ApiProblem('not_found', 'Такой публикации нет')
          }
          const plan = await planRows(db, [id])
          return {
            hub: 'ok',
            publication: rowOf(detail.publication, accountOf, plan),
            events: detail.events.map((event) => ({
              at: event.at,
              from: event.fromStatus,
              to: event.toStatus,
              actor: event.actorKind,
              reason: event.reason,
            })),
            approved_at: detail.approvedAt,
          }
        } catch (error) {
          if (error instanceof ApiProblem) throw error
          if (isHubError(error) && error.status === 404)
            throw new ApiProblem('not_found', 'Такой публикации нет')
          return { hub: failed(error), publication: null, events: [], approved_at: null }
        }
      },
    },
  }
}
