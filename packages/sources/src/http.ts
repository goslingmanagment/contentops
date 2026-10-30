import { networkError, SourceError } from './errors.ts'
import type { SourceKind } from './types.ts'

/** A string token or a provider (Dropbox short-lived tokens are refreshed by one). */
export interface TokenProvider {
  get(): Promise<string>
  /** Forget a cached token after the source called it expired. */
  invalidate?(): void
}

export type TokenInput = string | TokenProvider

export function tokenProvider(token: TokenInput): TokenProvider {
  return typeof token === 'string' ? { get: async () => token } : token
}

export interface HttpContext {
  source: SourceKind
  fetch: typeof fetch
  /** Per-request limit for metadata calls; downloads rely on the socket idle timeout. */
  timeoutMs: number
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | null): AbortSignal {
  const parts: AbortSignal[] = []
  if (signal) parts.push(signal)
  if (timeoutMs != null) parts.push(AbortSignal.timeout(timeoutMs))
  return AbortSignal.any(parts)
}

/**
 * One HTTP exchange. Network failures become `transient`, the caller's abort is rethrown
 * as is, and a non-2xx status goes to `onError` (each client reads its own error body).
 */
export async function send(
  ctx: HttpContext,
  endpoint: string,
  url: string,
  init: RequestInit & { signal?: AbortSignal; timeout?: boolean },
  onError: (res: Response, text: string) => SourceError,
): Promise<Response> {
  const signal = withTimeout(init.signal, init.timeout === false ? null : ctx.timeoutMs)
  let res: Response
  try {
    res = await ctx.fetch(url, { ...init, signal })
  } catch (e) {
    if (init.signal?.aborted) throw init.signal.reason
    throw networkError(ctx.source, endpoint, e)
  }
  if (res.ok) return res
  const text = await res.text().catch(() => '')
  throw onError(res, text)
}

/** Reads a JSON body; a cut stream is `transient`, broken JSON is `bad_response`. */
export async function readJson(
  ctx: HttpContext,
  endpoint: string,
  res: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch (e) {
    if (signal?.aborted) throw signal.reason
    throw networkError(ctx.source, endpoint, e)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new SourceError('bad_response', `malformed JSON from ${endpoint}`, {
      source: ctx.source,
      endpoint,
      status: res.status,
      cause: e,
    })
  }
}

/** Reads a binary body (thumbnails). */
export async function readBytes(
  ctx: HttpContext,
  endpoint: string,
  res: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    if (signal?.aborted) throw signal.reason
    throw networkError(ctx.source, endpoint, e)
  }
}

/** The body as chunks; a cut connection surfaces as a `transient` SourceError. */
export async function* guardBody(
  ctx: HttpContext,
  endpoint: string,
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!res.body) return
  try {
    for await (const chunk of res.body) yield chunk
  } catch (e) {
    if (signal?.aborted) throw signal.reason
    throw networkError(ctx.source, endpoint, e)
  }
}

/** `bytes 100-199/1000` → { start: 100, total: 1000 }. */
export function parseContentRange(
  value: string | null,
): { start: number; total: number | null } | null {
  const m = value?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/)
  if (!m?.[1] || !m[2]) return null
  return { start: Number(m[1]), total: m[2] === '*' ? null : Number(m[2]) }
}

/** Sizes and offsets of a download response. */
export function rangeOf(
  res: Response,
  requested: number,
): { offset: number; totalSize: number | null } {
  if (res.status === 206) {
    const range = parseContentRange(res.headers.get('content-range'))
    return { offset: range?.start ?? requested, totalSize: range?.total ?? null }
  }
  const length = res.headers.get('content-length')
  return { offset: 0, totalSize: length == null ? null : Number(length) }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** ISO 8601 in UTC, or null for anything that is not a parseable time. */
export function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}
