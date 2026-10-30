import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { HEADER, parseVersionTag } from '@contentops/contracts/api/headers'
import type { Role } from '@contentops/contracts/domain/people'
import { compile } from '@fastify/proxy-addr'
import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { ApiProblem } from './errors'

/** Who calls: a person by session or an agent by bearer token (SPEC §11.1). */
export interface Actor {
  type: 'person' | 'agent'
  id: string
  role: Role
  models: readonly string[]
}

/** Resolves the caller of a request; wired with sessions and tokens in a later PR. */
export type Authenticate = (request: FastifyRequest) => Promise<Actor | null> | Actor | null

/** What a handler knows about the request besides params, query and body. */
export interface RequestContext {
  /** Returned in `X-Request-Id` and in every error; the journal record carries the same. */
  requestId: string
  /** `null` until authentication is wired, then only on public routes. */
  actor: Actor | null
  /** `Idempotency-Key` of a command; enforced together with `idempotency_keys`. */
  idempotencyKey: string | null
  /** Version from `If-Match: "<n>"`; `requireIfMatch` gives 428 when it is absent. */
  ifMatch: number | null
  log: FastifyBaseLogger
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** `"12"` → 12; absent → null; anything else is a 400. */
export function readIfMatch(value: string | string[] | undefined): number | null {
  const raw = single(value)
  if (raw === undefined || raw.trim() === '') return null
  const tag = parseVersionTag(raw.trim())
  const version = Number(tag)
  if (!tag || !/^\d+$/.test(tag) || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiProblem('invalid_request', 'Неверная версия записи (If-Match)', {
      header: HEADER.ifMatch,
    })
  }
  return version
}

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/

export function readIdempotencyKey(value: string | string[] | undefined): string | null {
  const raw = single(value)
  if (raw === undefined || raw === '') return null
  if (!IDEMPOTENCY_KEY.test(raw)) {
    throw new ApiProblem('invalid_request', 'Неверный ключ повтора (Idempotency-Key)', {
      header: HEADER.idempotencyKey,
    })
  }
  return raw
}

/** For changes of existing records (SPEC §11.2): no condition — 428. */
export function requireIfMatch(context: RequestContext): number {
  if (context.ifMatch === null) {
    throw new ApiProblem('precondition_required', 'Нужна версия записи (If-Match)')
  }
  return context.ifMatch
}

export async function createRequestContext(
  request: FastifyRequest,
  authenticate: Authenticate | undefined,
): Promise<RequestContext> {
  const headers = request.headers
  const idempotencyKey = readIdempotencyKey(headers[HEADER.idempotencyKey.toLowerCase()])
  const ifMatch = readIfMatch(headers[HEADER.ifMatch.toLowerCase()])
  return {
    requestId: request.id,
    actor: authenticate ? await authenticate(request) : null,
    idempotencyKey,
    ifMatch,
    log: request.log,
  }
}

const INCOMING_REQUEST_ID = /^[\w.:-]{1,128}$/

/**
 * A fresh UUID per request; the local proxy's `X-Request-Id` is kept so its access log and
 * ours share the id. Anyone else's header is ignored.
 */
export function requestIdGenerator(trustedProxy: readonly string[]) {
  const trusted = compile([...trustedProxy])
  return (request: IncomingMessage): string => {
    const incoming = single(request.headers[HEADER.requestId.toLowerCase()])
    const peer = request.socket?.remoteAddress
    if (incoming && INCOMING_REQUEST_ID.test(incoming) && peer && trusted(peer, 0)) return incoming
    return randomUUID()
  }
}
