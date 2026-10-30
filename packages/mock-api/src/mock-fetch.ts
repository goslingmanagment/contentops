import type { FetchLike } from '@contentops/contracts/api/client'
import { HEADER, parseVersionTag } from '@contentops/contracts/api/headers'
import { matchPath } from '@contentops/contracts/api/route'
import type { ApiErrorBody } from '@contentops/contracts/domain/errors'
import { DomainError } from './domain-error'
import type { BoundAnswer, BoundRoute, RawRequest } from './handler'
import { allHandlers } from './handlers'
import type { MockOptions } from './options'
import { sampleAt, sampleText } from './sample-files'
import { createMockState, type MockState, type StoredAnswer } from './state'

/**
 * The prototype's server: a `fetch` that answers the API paths of SPEC §11.2 from data in
 * memory, with delays, `Idempotency-Key`, `If-Match`/`ETag`, 202 operations, 412, 422, 429.
 * No Service Worker: the client simply receives this function instead of `window.fetch`.
 */

export type MockFetch = FetchLike & { readonly state: MockState }

const BASE = 'http://contentops.local'
/** Session and models answer even in `?demo=loading` and `error`: the shell must draw. */
const ALWAYS_ANSWERED = new Set(['/api/v1/admin/me', '/api/v1/admin/models'])
/** The only path that answers a signed-out browser. */
const SIGN_IN_PATH = '/api/v1/auth/sign-in'

function abortError(): Error {
  return new DOMException('Запрос отменён', 'AbortError')
}

function wait(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError())
    })
  })
}

function never(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(abortError())
    signal?.addEventListener('abort', () => reject(abortError()))
  })
}

function errorAnswer(error: DomainError, requestId: string): StoredAnswer & { status: number } {
  const body: ApiErrorBody = { code: error.code, message: error.message, request_id: requestId }
  if (error.details) body.details = error.details
  const headers: Record<string, string> = { [HEADER.requestId]: requestId }
  if (error.retryAfterSeconds !== null) headers[HEADER.retryAfter] = String(error.retryAfterSeconds)
  return { digest: '', status: error.status, body: JSON.stringify(body), headers }
}

function findRoute(handlers: readonly BoundRoute[], method: string, url: URL) {
  for (const handler of handlers) {
    if (handler.route.method !== method) continue
    const params = matchPath(handler.route.path, url.pathname)
    if (params && handler.accepts(url.searchParams)) return { handler, params }
  }
  return null
}

function rateLimited(state: MockState): DomainError | null {
  const now = Date.now()
  state.mutation_times = state.mutation_times.filter(
    (time) => now - time < state.rate_limit.window_ms,
  )
  if (state.mutation_times.length >= state.rate_limit.requests) {
    const retry = Math.ceil(
      (state.rate_limit.window_ms - (now - (state.mutation_times[0] ?? now))) / 1000,
    )
    return new DomainError(
      'rate_limited',
      `Слишком часто — повторим через ${retry} с`,
      { retry_after_s: retry },
      retry,
    )
  }
  state.mutation_times.push(now)
  return null
}

function answerOf(bound: BoundAnswer, requestId: string, ifNoneMatch: string | null): StoredAnswer {
  const headers: Record<string, string> = { [HEADER.requestId]: requestId }
  if (bound.etag) headers[HEADER.etag] = bound.etag
  if (bound.etag && ifNoneMatch === bound.etag)
    return { digest: '', status: 304, body: '', headers }
  return { digest: '', status: bound.status, body: JSON.stringify(bound.body), headers }
}

function toResponse(answer: StoredAnswer): Response {
  if (answer.status === 304) return new Response(null, { status: 304, headers: answer.headers })
  return new Response(answer.body, {
    status: answer.status,
    headers: { [HEADER.contentType]: 'application/json', ...answer.headers },
  })
}

function demoAnswer(
  state: MockState,
  path: string,
  method: string,
  requestId: string,
  signal: AbortSignal | null | undefined,
): Promise<Response> | null {
  if (state.signed_out && path !== SIGN_IN_PATH) {
    const error = new DomainError('unauthenticated', 'Нужно войти')
    return Promise.resolve(toResponse(errorAnswer(error, requestId)))
  }
  if (ALWAYS_ANSWERED.has(path) || path === SIGN_IN_PATH) return null
  if (state.demo === 'loading') return never(signal)
  if (state.demo === 'error') {
    const error =
      method === 'GET'
        ? new DomainError('internal', 'Не загрузилось')
        : new DomainError('unavailable', 'Нет связи')
    return Promise.resolve(toResponse(errorAnswer(error, requestId)))
  }
  return null
}

function dispatch(
  state: MockState,
  handlers: readonly BoundRoute[],
  method: string,
  url: URL,
  init: RequestInit,
  requestId: string,
): StoredAnswer {
  const found = findRoute(handlers, method, url)
  if (!found) {
    const knownPath = handlers.some((handler) => matchPath(handler.route.path, url.pathname))
    return errorAnswer(
      new DomainError(
        knownPath ? 'invalid_request' : 'not_found',
        knownPath ? 'Неверные параметры запроса' : 'Нет такого адреса',
      ),
      requestId,
    )
  }
  const headers = new Headers(init.headers)
  const ifMatch = parseVersionTag(headers.get(HEADER.ifMatch))
  const bodyText = typeof init.body === 'string' ? init.body : null
  const idempotencyKey = method === 'GET' ? null : headers.get(HEADER.idempotencyKey)
  const digest = `${method} ${url.pathname}${url.search} ${bodyText ?? ''} ${ifMatch ?? ''}`
  if (idempotencyKey) {
    const stored = state.idempotency.get(idempotencyKey)
    if (stored && stored.digest !== digest) {
      return errorAnswer(
        new DomainError('idempotency_conflict', 'Ключ повтора уже использован другим запросом'),
        requestId,
      )
    }
    if (stored) return stored
  }
  if (method !== 'GET') {
    const limited = rateLimited(state)
    if (limited) return errorAnswer(limited, requestId)
  }
  const request: RawRequest = {
    path_params: found.params,
    search: url.searchParams,
    body_text: bodyText,
    if_match: ifMatch === null ? null : Number(ifMatch),
    request_id: requestId,
  }
  try {
    const answer = answerOf(
      found.handler.run(request, state),
      requestId,
      headers.get(HEADER.ifNoneMatch),
    )
    if (idempotencyKey) state.idempotency.set(idempotencyKey, { ...answer, digest })
    return answer
  } catch (error) {
    if (error instanceof DomainError) return errorAnswer(error, requestId)
    const message = error instanceof Error ? error.message : String(error)
    return errorAnswer(
      new DomainError('internal', `Внутренняя ошибка заглушки: ${message}`),
      requestId,
    )
  }
}

/** A `fetch` for the prototype; `createApiClient(createMockFetch({ demo, role }))`. */
export function createMockFetch(options: MockOptions = {}): MockFetch {
  const state = createMockState(options)
  const handlers = allHandlers()
  const mockFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, BASE)
    const method = (init.method ?? 'GET').toUpperCase()
    state.request_counter += 1
    const requestId = `req-${state.request_counter}`
    const latency = state.latency
    if (latency)
      await wait(latency.min_ms + Math.random() * (latency.max_ms - latency.min_ms), init.signal)
    const demo = demoAnswer(state, url.pathname, method, requestId, init.signal)
    if (demo) return demo
    const sample = method === 'GET' ? sampleAt(state, url) : null
    if (sample) {
      return new Response(sampleText(sample), {
        status: 200,
        headers: {
          [HEADER.contentType]: 'text/plain; charset=utf-8',
          [HEADER.requestId]: requestId,
        },
      })
    }
    return toResponse(dispatch(state, handlers, method, url, init, requestId))
  }
  return Object.assign(mockFetch, { state })
}
