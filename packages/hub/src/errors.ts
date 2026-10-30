/**
 * Errors of the Hub client (SPEC §8, §8.1).
 *
 * - `auth_rejected` — 401/403: the key is not accepted or lacks a right; retries stop until
 *   the owner replaces it (SPEC §8: «токен не принят с 13:40», the time is `at`).
 * - `rate_limited` — 429; `retryAfterMs` from `Retry-After`.
 * - `transient` — 5xx, 408, a network failure, a connection cut mid-body, a timeout.
 * - `bad_response` — an answer that breaks the contract: malformed JSON, a missing section
 *   the client reads, a pinned field of the wrong type, an unexpected status.
 * - `refused` — Hub said no on purpose (400, 404, 409, 413, 415, 507): `code` is Hub's own
 *   (`publication_handed_to_platform`, `publication_not_editable`, `agent_cursor_invalid`…),
 *   passed through as is.
 */
export type HubErrorKind =
  | 'auth_rejected'
  | 'rate_limited'
  | 'transient'
  | 'bad_response'
  | 'refused'

/** Codes Hub answers on the routes this client calls; any other code passes through too. */
export const HUB_REFUSAL_CODES = [
  /** 409: Hub has sent the publication to the platform; only the owner takes it off, in Hub. */
  'publication_handed_to_platform',
  /** 409: the status does not allow it (cancel of a finished one, not this key's draft). */
  'publication_not_editable',
  /** 409: the publication changed between the read and the command. */
  'publication_version_conflict',
  /** 409: the same `idempotencyKey` came with another draft body. */
  'idempotency_mismatch',
  /** 413 / 415 / 507: upload refusals. */
  'publication_file_too_large',
  'publication_file_type',
  'publication_files_full',
  /** 400: a cursor minted before a Hub rebuild, for another key or scope: start the read again. */
  'agent_cursor_invalid',
  /** 409 on upload: the same bytes arrived at the same moment; sending again is safe. */
  'conflict',
  'bad_request',
  'not_found',
] as const

export type HubRefusalCode = (typeof HUB_REFUSAL_CODES)[number] | (string & {})

export interface HubErrorInit {
  /** Logical endpoint (`capabilities`, `dataset`, `publications.cancel`…). */
  endpoint: string
  status?: number
  code?: string
  retryAfterMs?: number
  at?: Date
  cause?: unknown
}

export class HubError extends Error {
  readonly kind: HubErrorKind
  readonly endpoint: string
  readonly status: number | null
  readonly code: HubRefusalCode | null
  readonly retryAfterMs: number | null
  /** When it happened; for `auth_rejected` — «токен не принят с …». */
  readonly at: Date

  constructor(kind: HubErrorKind, message: string, init: HubErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'HubError'
    this.kind = kind
    this.endpoint = init.endpoint
    this.status = init.status ?? null
    this.code = init.code ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.at = init.at ?? new Date()
  }

  /** Worth another attempt after a pause. Auth, refusals and broken answers are not. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'transient'
  }
}

export function isHubError(e: unknown, kind?: HubErrorKind, code?: string): e is HubError {
  return (
    e instanceof HubError &&
    (kind === undefined || e.kind === kind) &&
    (code === undefined || e.code === code)
  )
}

/** `Retry-After`: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

export function kindForStatus(status: number): HubErrorKind {
  if (status === 401 || status === 403) return 'auth_rejected'
  if (status === 429) return 'rate_limited'
  // 507 `publication_files_full`: Hub's file store is full — the owner's matter, not a blip.
  if ([400, 404, 409, 410, 413, 415, 422, 507].includes(status)) return 'refused'
  if (status === 408 || status >= 500) return 'transient'
  return 'bad_response'
}
