import type { SourceKind } from './types.ts'

/**
 * - `auth_rejected` — 401/403: the token is not accepted; retries stop until the owner
 *   replaces it (SPEC §8: «токен не принят с HH:MM», the time is `at`).
 * - `rate_limited` — 429; `retryAfterMs` from `Retry-After` (or the Dropbox body).
 * - `transient` — 5xx, a network failure, a connection cut mid-body, a locked resource.
 * - `not_found` — the path or id is not there (any more).
 * - `bad_response` — an answer that breaks the contract: malformed JSON, missing fields,
 *   an unexpected status, a checksum that never matches.
 */
export type SourceErrorKind =
  | 'auth_rejected'
  | 'rate_limited'
  | 'transient'
  | 'not_found'
  | 'bad_response'

export interface SourceErrorInit {
  source: SourceKind
  endpoint: string
  status?: number
  /** Provider's own error code: Yandex `error`, Dropbox `error_summary`. */
  code?: string
  retryAfterMs?: number
  at?: Date
  cause?: unknown
}

export class SourceError extends Error {
  readonly kind: SourceErrorKind
  readonly source: SourceKind
  readonly endpoint: string
  readonly status: number | null
  readonly code: string | null
  readonly retryAfterMs: number | null
  /** When it happened; for `auth_rejected` — «токен не принят с …». */
  readonly at: Date

  constructor(kind: SourceErrorKind, message: string, init: SourceErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'SourceError'
    this.kind = kind
    this.source = init.source
    this.endpoint = init.endpoint
    this.status = init.status ?? null
    this.code = init.code ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.at = init.at ?? new Date()
  }

  /** Worth another attempt after a pause. Auth, missing and broken answers are not. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'transient'
  }
}

export function isSourceError(e: unknown, kind?: SourceErrorKind, code?: string): e is SourceError {
  return (
    e instanceof SourceError &&
    (kind === undefined || e.kind === kind) &&
    (code === undefined || e.code === code)
  )
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** `Retry-After`: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

/** Maps a status to a kind; the clients refine 404/409 with the provider's code. */
export function kindForStatus(status: number): SourceErrorKind {
  if (status === 401 || status === 403) return 'auth_rejected'
  if (status === 429) return 'rate_limited'
  if (status === 404 || status === 410) return 'not_found'
  // 423 — Yandex `DiskResourceLockedError` (the resource is being written right now).
  if (status === 408 || status === 423 || status >= 500) return 'transient'
  return 'bad_response'
}

/** A network-level failure (refused, reset, cut mid-body) as a transient error. */
export function networkError(source: SourceKind, endpoint: string, cause: unknown): SourceError {
  const detail = cause instanceof Error ? (cause.cause as Error | undefined)?.message : undefined
  const message = cause instanceof Error ? cause.message : String(cause)
  return new SourceError('transient', `network: ${message}${detail ? ` (${detail})` : ''}`, {
    source,
    endpoint,
    cause,
  })
}
