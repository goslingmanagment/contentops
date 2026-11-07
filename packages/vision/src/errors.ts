import type { Usage } from './types.ts'

/**
 * Failures of a request to a provider (SPEC §8.3). A refusal is not one of them: it is an
 * answer (`VisionResult.kind === 'refused'`).
 *
 * - `auth_rejected` — 401, 403, 402, a quota or a warning of the account: the provider stops
 *   until the owner looks into it, nothing goes to it meanwhile.
 * - `rate_limited` — 429; `retryAfterMs` when the provider says it.
 * - `transient` — 5xx, 529, or a connection that never opened: the provider did not take it.
 * - `unknown_outcome` — the request left and no answer came (a timeout, a cut connection):
 *   whether it was done and paid is not known, so it is never sent again by itself.
 * - `bad_request` — another 4xx (an unknown model, a too large request): the settings are
 *   wrong, a repeat gives the same.
 * - `bad_response` — an answer that does not parse or breaks the schema; it may be paid.
 */
export type VisionErrorKind =
  | 'auth_rejected'
  | 'rate_limited'
  | 'transient'
  | 'unknown_outcome'
  | 'bad_request'
  | 'bad_response'

export class VisionError extends Error {
  readonly kind: VisionErrorKind
  readonly status: number | null
  readonly requestId: string | null
  readonly retryAfterMs: number | null
  /** Tokens the provider reported for an answer it gave but that did not parse. */
  readonly usage: Usage | null

  constructor(
    kind: VisionErrorKind,
    message: string,
    init: {
      status?: number | null
      requestId?: string | null
      retryAfterMs?: number | null
      usage?: Usage | null
      cause?: unknown
    } = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'VisionError'
    this.kind = kind
    this.status = init.status ?? null
    this.requestId = init.requestId ?? null
    this.retryAfterMs = init.retryAfterMs ?? null
    this.usage = init.usage ?? null
  }
}

/** Network errors raised before a connection opened: nothing reached the provider. */
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** True when the error chain says the connection never opened. */
export function neverConnected(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && CONNECT_CODES.has(code)) return true
  }
  return false
}

/** `Retry-After` in seconds or as a date; `null` when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** A refusal said in words by a provider's policy error or instead of the JSON answer. */
const POLICY_WORDS = new RegExp(
  [
    'usage polic',
    'content polic',
    'safety (system|polic)',
    'flagged',
    'violat',
    'moderation',
    'content filter',
    '\\brefus',
    "(can[’']?t|cannot|unable to|won[’']?t|will not|not able to) (help|assist|describe|do|provide|comply|process)",
    "i[’']?m sorry",
    'не могу',
    'не буду',
  ].join('|'),
  'i',
)

export function soundsLikeRefusal(text: string): boolean {
  return POLICY_WORDS.test(text)
}
