import type { z } from 'zod'
import { ApiErrorBodySchema } from '../domain/errors'
import { ApiError } from './errors'
import { HEADER, versionTag } from './headers'
import { newIdempotencyKey } from './idempotency-key'
import { buildPath, type PathParams, type Route, toSearchParams } from './route'
import { type ApiRoutes, apiRoutes } from './routes'

/**
 * Any `fetch`: the browser one, or the mock of the prototype. The client also passes the
 * route of the call, so one `fetch` can send some routes to the server and the rest elsewhere.
 */
export type FetchLike = (input: string, init: RequestInit, route?: Route) => Promise<Response>

type Empty = Record<string, never>

type ParamsInput<R extends Route> = keyof PathParams<R['path']> extends never
  ? { params?: Empty }
  : { params: PathParams<R['path']> }

type NoKeys = Record<never, never>

type QueryInput<R extends Route> =
  NoKeys extends z.input<R['query']>
    ? { query?: z.input<R['query']> }
    : { query: z.input<R['query']> }

type BodyInput<R extends Route> =
  undefined extends z.input<R['body']>
    ? { body?: z.input<R['body']> }
    : { body: z.input<R['body']> }

export interface CallOptions {
  /** Version the change is based on; sent as `If-Match`. */
  ifMatch?: number
  /** Repeat of an intent after an error: pass the key of the first attempt. */
  idempotencyKey?: string
  signal?: AbortSignal
}

export type RouteInput<R extends Route> = ParamsInput<R> &
  QueryInput<R> &
  BodyInput<R> &
  CallOptions
export type RouteOutput<R extends Route> = z.output<R['response']>

export type ConditionalResult<T> =
  | { status: 'not_modified'; etag: string }
  | { status: 'ok'; etag: string | null; data: T }

type AreaClient<Area extends Record<string, Route>> = {
  [Name in keyof Area]: (input: RouteInput<Area[Name]>) => Promise<RouteOutput<Area[Name]>>
}

export type ApiClient = { [Area in keyof ApiRoutes]: AreaClient<ApiRoutes[Area]> } & {
  /** Any route by its definition. */
  call<R extends Route>(route: R, input: RouteInput<R>): Promise<RouteOutput<R>>
  /** A read with `If-None-Match`: the index resources are polled this way (DESIGN §3.13). */
  conditional<R extends Route>(
    route: R,
    input: RouteInput<R> & { etag: string | null },
  ): Promise<ConditionalResult<RouteOutput<R>>>
  url<R extends Route>(route: R, input: ParamsInput<R> & QueryInput<R>): string
}

export interface ApiClientOptions {
  /** Prefix before `/api/v1`, empty for the same origin. */
  baseUrl?: string
}

interface LooseInput {
  params?: Record<string, string>
  query?: Record<string, string | number | boolean | readonly string[] | null | undefined>
  body?: unknown
  ifMatch?: number
  idempotencyKey?: string
  signal?: AbortSignal
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get(HEADER.retryAfter)
  if (!value) return null
  const seconds = Number(value)
  return Number.isFinite(seconds) ? seconds : null
}

async function errorFrom(response: Response): Promise<ApiError> {
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const body = ApiErrorBodySchema.safeParse(parsed)
  const fallback = {
    code: 'internal' as const,
    message: 'Не удалось выполнить запрос',
    request_id: response.headers.get(HEADER.requestId) ?? 'unknown',
  }
  return new ApiError(response.status, body.success ? body.data : fallback, retryAfter(response))
}

export function createApiClient(fetchImpl: FetchLike, options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? ''

  const urlOf = (route: Route, input: LooseInput): string => {
    const path = buildPath(route.path, (input.params ?? {}) as PathParams<string>)
    const search = toSearchParams(input.query ?? {}).toString()
    return `${baseUrl}${path}${search ? `?${search}` : ''}`
  }

  const request = (route: Route, input: LooseInput, extraHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders }
    if (input.ifMatch !== undefined) headers[HEADER.ifMatch] = versionTag(input.ifMatch)
    if (route.method !== 'GET')
      headers[HEADER.idempotencyKey] = input.idempotencyKey ?? newIdempotencyKey()
    const init: RequestInit = { method: route.method, headers }
    if (input.signal) init.signal = input.signal
    if (input.body !== undefined) {
      headers[HEADER.contentType] = 'application/json'
      init.body = JSON.stringify(input.body)
    }
    return fetchImpl(urlOf(route, input), init, route)
  }

  const call = async (route: Route, input: LooseInput): Promise<unknown> => {
    const response = await request(route, input)
    if (!response.ok) throw await errorFrom(response)
    return route.response.parse(await response.json())
  }

  const conditional = async (route: Route, input: LooseInput & { etag: string | null }) => {
    const headers: Record<string, string> = input.etag ? { [HEADER.ifNoneMatch]: input.etag } : {}
    const response = await request(route, input, headers)
    if (response.status === 304) return { status: 'not_modified' as const, etag: input.etag ?? '' }
    if (!response.ok) throw await errorFrom(response)
    const data = route.response.parse(await response.json())
    return { status: 'ok' as const, etag: response.headers.get(HEADER.etag), data }
  }

  // Area methods are built from `apiRoutes` at run time; the mapped `ApiClient` type describes them.
  const areas = Object.fromEntries(
    Object.entries(apiRoutes).map(([area, routes]) => [
      area,
      Object.fromEntries(
        Object.entries(routes).map(([name, route]) => [
          name,
          (input: LooseInput) => call(route as Route, input),
        ]),
      ),
    ]),
  )

  return {
    ...areas,
    call: (route: Route, input: LooseInput) => call(route, input),
    conditional: (route: Route, input: LooseInput & { etag: string | null }) =>
      conditional(route, input),
    url: (route: Route, input: LooseInput) => urlOf(route, input),
  } as ApiClient
}
