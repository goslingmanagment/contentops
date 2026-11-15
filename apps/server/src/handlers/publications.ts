import type {
  PublicationActionAnswer,
  PublicationCard,
  PublicationPage,
  PublicationRow,
  PublicationSwitches,
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

/** Hub's words for a person, or a plain sentence when it answered with a code. */
function wordsOf(reason: string | null, fallback: string): string {
  return reason && /[а-яё]/i.test(reason) ? reason : fallback
}

/** Hub's refusal of an action, said; a grant that is over ends the session. */
function actionProblem(error: unknown, fallback: string): never {
  if (!isHubError(error)) throw error
  if (error.status === 401)
    throw new ApiProblem('unauthenticated', 'Вход закончился: войдите снова')
  if (error.status === 403) throw new ApiProblem('forbidden', 'Это действие вашей роли не открыто')
  if (error.status === 404) throw new ApiProblem('not_found', 'Такой публикации нет')
  if (error.status === 409 || error.status === 400) {
    throw new ApiProblem('publication_refused', wordsOf(hubWords(error), fallback))
  }
  throw new ApiProblem('unavailable', 'Ответа нет: неизвестно, сделано ли. Обновите и посмотрите')
}

/** What Hub said in its refusal (its message without the status line). */
function hubWords(error: { message: string }): string {
  return error.message.replace(/^HTTP \d+\s*/, '')
}

export function publicationsHandlers(services: Services): HandlerRegistry {
  const { db } = services
  const slugOf = (model: ModelScope) => hubSlugOf(services.hubSignin?.setup.modelMap, model)
  type Ctx = Parameters<typeof requireActor>[0]

  /** The person's door and grant for an action; without a grant nothing is done. */
  async function actorDoor(ctx: Ctx) {
    const person = await personOf(services, requireActor(ctx))
    if (person.state === 'no_hub')
      throw new ApiProblem('unavailable', 'Публикации ещё не подключены')
    if (person.state === 'no_grant') {
      throw new ApiProblem(
        'forbidden',
        'Публикации меняет человек с учётной записью из реестра людей. Попросите владельца',
      )
    }
    return { door: person.door, grant: person.grant }
  }

  /** The post must be on a page of this model (Hub's cut for the person), else it is not here. */
  async function ofModel(ctx: Ctx, door: PersonDoor, grant: string, id: number) {
    const model = modelOf(ctx.model)
    const [detail, settings] = await Promise.all([
      door.publicationGet(grant, id),
      door.publicationSettings(grant, slugOf(model)),
    ]).catch((error: unknown) => actionProblem(error, 'Пост не нашёлся'))
    if (!settings.pages.some((page) => page.pageLabel === detail.publication.pageLabel)) {
      throw new ApiProblem('not_found', 'Такой публикации нет')
    }
    return detail.publication
  }

  async function pageOfModel(ctx: Ctx, door: PersonDoor, grant: string, page: string) {
    const settings = await door
      .publicationSettings(grant, slugOf(modelOf(ctx.model)))
      .catch((error: unknown) => actionProblem(error, 'Ответа нет: обновите чуть позже'))
    const found = settings.pages.find((one) => one.pageLabel === page)
    if (!found) throw new ApiProblem('not_found', 'Такой страницы нет')
    return found
  }

  const idOf = (raw: string) => {
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) throw new ApiProblem('not_found', 'Такой публикации нет')
    return id
  }
  const done = (publicationId: number | null = null): PublicationActionAnswer => ({
    outcome: 'done',
    words: null,
    publication_id: publicationId,
  })
  /** A withdrawal's or a deletion's outcome: a refusal is said in Hub's words. */
  const withdrawn = (
    results: readonly { outcome: string; reason: string | null }[],
    fallback: string,
  ): PublicationActionAnswer => {
    const refused = results.find((one) => ['refused', 'rejected', 'not_sent'].includes(one.outcome))
    return refused
      ? { outcome: 'refused', words: wordsOf(refused.reason, fallback), publication_id: null }
      : done()
  }

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
          login_needed: [],
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
          // «Нужен вход в Fansly» is the owner's to see (Hub refuses it to anyone else).
          const login =
            actor.role === 'owner'
              ? await person.door.fanslyLoginPages(person.grant).catch(() => [] as string[])
              : []
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
            login_needed: login.filter((label) => ours.has(label)),
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

      // The actions, each done by Hub as the signed-in person (package C2, PR 3): Hub says yes or no.
      approve: async ({ ctx, params, body }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        const [result] = await door
          .publicationApprove(grant, [{ id, version: body.version }])
          .catch((error: unknown) => actionProblem(error, 'Пост не утвердился'))
        if (result?.approved) return done(id)
        const why: Record<string, string> = {
          blocking_findings: 'Есть замечания, которые не дают утвердить',
          version_conflict: 'Пост изменился, пока вы смотрели: откройте его снова',
        }
        return {
          outcome: 'refused',
          words: why[result?.reason ?? ''] ?? wordsOf(result?.reason ?? null, 'Пост не утвердился'),
          publication_id: id,
        }
      },
      cancel: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        await door
          .publicationCancel(grant, id)
          .catch((error: unknown) =>
            actionProblem(
              error,
              'Пост уже отдан площадке: отменить нельзя, можно убрать из расписания',
            ),
          )
        return done(id)
      },
      withdraw: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        const results = await door
          .publicationWithdraw(grant, id)
          .catch((error: unknown) => actionProblem(error, 'Пост не убрался из расписания'))
        return withdrawn(results, 'Пост не убрался из расписания')
      },
      replace: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        const draft = await door
          .publicationReplace(grant, id)
          .catch((error: unknown) => actionProblem(error, 'Заменить можно только убранный пост'))
        return done(draft.id)
      },
      resolve: async ({ ctx, params, body }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        const answer =
          body.outcome === 'went_out'
            ? {
                outcome: 'went_out' as const,
                ...(body.platform_post_ref ? { platformPostRef: body.platform_post_ref } : {}),
              }
            : { outcome: 'did_not_go_out' as const }
        const resolved = await door
          .publicationResolve(grant, id, answer)
          .catch((error: unknown) => actionProblem(error, 'Ответ не принят'))
        return done(resolved.replacementId ?? id)
      },
      deletePost: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        const id = idOf(params.publication)
        await ofModel(ctx, door, grant, id)
        const results = await door
          .publicationDeletePost(grant, id)
          .catch((error: unknown) => actionProblem(error, 'Пост не удалился со стены'))
        return withdrawn(results, 'Пост не удалился со стены')
      },
      refreshPage: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        await pageOfModel(ctx, door, grant, params.page)
        try {
          await door.publicationQueueRefresh(grant, params.page)
        } catch (error) {
          if (isHubError(error) && error.status === 409) {
            return {
              outcome: 'refused',
              words: wordsOf(hubWords(error), 'Расписание этой страницы сейчас не читается'),
              publication_id: null,
            }
          }
          actionProblem(error, 'Расписание этой страницы сейчас не читается')
        }
        return done()
      },
      withdrawPage: async ({ ctx, params }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        await pageOfModel(ctx, door, grant, params.page)
        const results = await door
          .publicationWithdrawPage(grant, params.page)
          .catch((error: unknown) => actionProblem(error, 'Посты не убрались из расписания'))
        return withdrawn(results, 'Из расписания убраны не все посты')
      },
      pageSettings: async ({ ctx, params, body }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        await pageOfModel(ctx, door, grant, params.page)
        await door
          .publicationSettingsUpdate(grant, params.page, {
            enabled: body.enabled,
            paidPriceMinMills: body.paid_price_min_mills,
            paidPriceMaxMills: body.paid_price_max_mills,
            repostThresholdDays: body.repost_threshold_days,
            dailyLimit: body.daily_limit,
          })
          .catch((error: unknown) => actionProblem(error, 'Настройки не сохранились'))
        return done()
      },
      switches: async ({ ctx }): Promise<PublicationSwitches> => {
        const person = await personOf(services, requireActor(ctx))
        if (person.state !== 'ok') return { hub: person.state, switches: [], ofapi: null }
        try {
          const all = await person.door.publicationSwitches(person.grant)
          return {
            hub: 'ok',
            switches: all
              .filter((one) => one.key !== 'ofapiApiKey')
              .map((one) => ({ key: one.key, value: one.value, version: one.version })),
            ofapi: all.find((one) => one.key === 'ofapiApiKey')?.isSet ?? null,
          }
        } catch (error) {
          return { hub: failed(error), switches: [], ofapi: null }
        }
      },
      setSwitches: async ({ ctx, body }): Promise<PublicationActionAnswer> => {
        const { door, grant } = await actorDoor(ctx)
        await door
          .publicationSwitchSet(
            grant,
            body.patches.map((patch) => ({
              key: patch.key,
              value: patch.value,
              ...(patch.expected_version === undefined
                ? {}
                : { expectedVersion: patch.expected_version }),
            })),
          )
          .catch((error: unknown) => actionProblem(error, 'Выключатель не сохранился'))
        return done()
      },
    },
  }
}
