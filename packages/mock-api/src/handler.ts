import { fromSearchParams, type PathParams, type Route } from '@contentops/contracts/api/route'
import { addMinutes, instantMs, mskDate } from '@contentops/contracts/clock'
import type { ModelCode } from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type { JournalArea, JournalEvent } from '@contentops/contracts/domain/journal'
import type { Role } from '@contentops/contracts/domain/people'
import type { z } from 'zod'
import { DomainError, forbidden, notFound } from './domain-error'
import type { FactsContext } from './fixtures/facts'
import type { ModelWorld } from './fixtures/world-types'
import type { MockState } from './state'

/** Who may call a route: anyone with the model, staff (not «только чтение»), or the owner. */
export type Access = 'read' | 'staff' | 'owner'

export interface LogEntry {
  area: JournalArea
  action: string
  phrase: string
  item_id?: ItemId | null
  changes?: JournalEvent['changes']
  model?: ModelCode
}

export interface HandlerContext<R extends Route> {
  params: PathParams<R['path']>
  query: z.output<R['query']>
  body: z.output<R['body']>
  if_match: number | null
  state: MockState
  request_id: string
  /** The model of the path, after the access check (403 without rights, 404 unknown). */
  model(): ModelWorld
  facts(): FactsContext
  /** Checks `If-Match` against the current version: 428 without it, 412 when stale. */
  requireVersion(current: number, field?: string): void
  log(entry: LogEntry): void
}

export type Handler<R extends Route> = (context: HandlerContext<R>) => z.input<R['response']>

export interface RawRequest {
  path_params: Record<string, string>
  search: URLSearchParams
  body_text: string | null
  if_match: number | null
  request_id: string
}

export interface BoundAnswer {
  status: number
  body: unknown
  etag: string | null
}

export interface BoundRoute {
  route: Route
  /** The query fits this route; two routes may share a path and differ by query. */
  accepts(search: URLSearchParams): boolean
  run(request: RawRequest, state: MockState): BoundAnswer
}

export interface BindOptions<R extends Route> {
  etag?: (body: z.output<R['response']>) => string | null
}

const STAFF_ROLES: readonly Role[] = ['owner', 'manager']

function checkAccess(access: Access, role: Role) {
  if (access === 'staff' && !STAFF_ROLES.includes(role)) throw forbidden('Недостаточно прав')
  if (access === 'owner' && role !== 'owner') throw forbidden('Это может только владелец')
}

function parseBody(text: string | null): unknown {
  if (text === null || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new DomainError('invalid_request', 'Тело запроса не JSON')
  }
}

function modelOf(state: MockState, code: string | undefined): ModelWorld {
  if (!code) throw notFound('Модель не указана')
  const model = state.world.models.get(code)
  if (!model) throw notFound(`Модели ${code} нет`)
  if (!state.principal.models.includes(code)) throw forbidden()
  return model
}

function logger(state: MockState, requestId: string, pathModel: string | undefined) {
  return (entry: LogEntry) => {
    const code = entry.model ?? pathModel
    const model = code ? state.world.models.get(code) : undefined
    if (!model) return
    model.journal.unshift({
      id: `ev-${requestId}-${model.journal.length}`,
      at: state.clock.now(),
      actor: state.actor,
      area: entry.area,
      action: entry.action,
      phrase: entry.phrase,
      item_id: entry.item_id ?? null,
      thumb: entry.item_id ? { key: entry.item_id, ratio: '3:4' } : null,
      result: 'ok',
      changes: entry.changes ?? [],
      request_id: requestId,
    })
  }
}

/** Кто «успел изменить» запись в прототипе: не тот, кто сейчас правит. */
function otherEditor(state: MockState): { name: string; gender: 'f' | 'm' } {
  return state.principal.name === 'Диана'
    ? { name: 'Никита', gender: 'm' }
    : { name: 'Диана', gender: 'f' }
}

function versionChecker(state: MockState, ifMatch: number | null) {
  return (current: number, field?: string) => {
    const editor = otherEditor(state)
    const conflict = () =>
      new DomainError('version_mismatch', 'Запись уже изменили', {
        changed_by: editor.name,
        changed_by_gender: editor.gender,
        changed_at: addMinutes(state.clock.now(), -1),
        field: field ?? null,
        current_version: current + (state.demo === 'conflict' ? 1 : 0),
        current_value: null,
      })
    if (state.demo === 'conflict') throw conflict()
    if (ifMatch === null)
      throw new DomainError('precondition_required', 'Нужна версия записи (If-Match)')
    if (ifMatch !== current) throw conflict()
  }
}

/** Binds a handler to its route: parsing, access, validation of the answer. */
export function bind<R extends Route>(
  route: R,
  access: Access,
  handler: NoInfer<Handler<R>>,
  options: NoInfer<BindOptions<R>> = {},
): BoundRoute {
  return {
    route,
    accepts: (search) => route.query.safeParse(fromSearchParams(search)).success,
    run(request, state) {
      checkAccess(access, state.principal.role)
      const pathModel = request.path_params.model
      if (pathModel !== undefined) modelOf(state, pathModel)
      const query = route.query.safeParse(fromSearchParams(request.search))
      if (!query.success) throw new DomainError('invalid_request', 'Неверные параметры запроса')
      const body = route.body.safeParse(parseBody(request.body_text))
      if (!body.success) {
        throw new DomainError('invalid_request', 'Неверное тело запроса', {
          issues: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        })
      }
      let facts: FactsContext | null = null
      const context: HandlerContext<R> = {
        // The path matched this route's template, so every named parameter is present.
        params: request.path_params as PathParams<R['path']>,
        // Schemas of a generic route resolve to `unknown`; the parse above proves the shapes.
        query: query.data as z.output<R['query']>,
        body: body.data as z.output<R['body']>,
        if_match: request.if_match,
        state,
        request_id: request.request_id,
        model: () => modelOf(state, pathModel),
        facts: () => {
          facts ??= { now: state.clock.now(), world: state.world, model: modelOf(state, pathModel) }
          return facts
        },
        requireVersion: versionChecker(state, request.if_match),
        log: logger(state, request.request_id, pathModel),
      }
      const answer = route.response.parse(handler(context)) as z.output<R['response']>
      return { status: route.success, body: answer, etag: options.etag?.(answer) ?? null }
    },
  }
}

/** Today in Moscow for the mock clock. */
export function todayOf(state: MockState): string {
  return mskDate(state.clock.now())
}

export function minutesSince(state: MockState, instant: string): number {
  return (instantMs(state.clock.now()) - instantMs(instant)) / 60_000
}
