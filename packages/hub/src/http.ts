import { HubError, kindForStatus, parseRetryAfter } from './errors.ts'

export interface HttpContext {
  baseUrl: string
  key: string
  fetch: typeof fetch
  /** Per-request limit; an upload sets `timeout: false` and relies on the socket. */
  timeoutMs: number
  now: () => Date
}

export interface CallInit {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string | undefined>
  /** A JSON body. */
  json?: unknown
  /** A raw body (uploads). */
  body?: Uint8Array | ReadableStream<Uint8Array>
  headers?: Record<string, string>
  signal?: AbortSignal
  timeout?: boolean
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | null): AbortSignal {
  const parts: AbortSignal[] = []
  if (signal) parts.push(signal)
  if (timeoutMs != null) parts.push(AbortSignal.timeout(timeoutMs))
  return AbortSignal.any(parts)
}

function networkError(endpoint: string, cause: unknown): HubError {
  const detail = cause instanceof Error ? (cause.cause as Error | undefined)?.message : undefined
  const message = cause instanceof Error ? cause.message : String(cause)
  return new HubError('transient', `network: ${message}${detail ? ` (${detail})` : ''}`, {
    endpoint,
    cause,
  })
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * One exchange with Hub that answers JSON. Network failures and a body cut mid-way become
 * `transient`, the caller's abort is rethrown as is, a non-2xx status maps by
 * `kindForStatus` with Hub's `error` code, and a body that does not parse is `bad_response`.
 */
export async function callJson(
  ctx: HttpContext,
  endpoint: string,
  init: CallInit,
): Promise<unknown> {
  const url = new URL(
    init.path.replace(/^\//, ''),
    ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`,
  )
  for (const [k, v] of Object.entries(init.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, v)
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.key}`,
    accept: 'application/json',
    ...init.headers,
  }
  let body: RequestInit['body']
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  } else if (init.body !== undefined) {
    body = init.body as RequestInit['body']
  }
  const signal = withTimeout(init.signal, init.timeout === false ? null : ctx.timeoutMs)
  let res: Response
  try {
    res = await ctx.fetch(url, {
      method: init.method,
      headers,
      body,
      signal,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit)
  } catch (e) {
    if (init.signal?.aborted) throw init.signal.reason
    throw networkError(endpoint, e)
  }
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    if (init.signal?.aborted) throw init.signal.reason
    throw networkError(endpoint, e)
  }
  if (!res.ok) throw errorFor(ctx, endpoint, res, text)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new HubError('bad_response', `malformed JSON from ${endpoint}`, {
      endpoint,
      status: res.status,
      cause: e,
    })
  }
}

function errorFor(ctx: HttpContext, endpoint: string, res: Response, text: string): HubError {
  let code: string | undefined
  let message: string | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string') code = parsed.error
      if (typeof parsed.message === 'string') message = parsed.message
    }
  } catch {
    // an HTML page of a proxy or an empty body: the status says enough
  }
  const kind = kindForStatus(res.status)
  const at = ctx.now()
  return new HubError(
    kind,
    `${endpoint}: HTTP ${res.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`,
    {
      endpoint,
      status: res.status,
      ...(code === undefined ? {} : { code }),
      ...(kind === 'rate_limited'
        ? { retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), at.getTime()) }
        : {}),
      at,
    },
  )
}

/** A section the client reads is missing or has the wrong shape. */
export function badShape(endpoint: string, what: string): HubError {
  return new HubError('bad_response', `${endpoint}: ${what}`, { endpoint })
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** RFC 3339 with seconds and a zone, as Hub's agent API wants it. */
export function isoTime(v: Date | string): string {
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) throw new TypeError(`not a time: ${String(v)}`)
  return d.toISOString()
}
