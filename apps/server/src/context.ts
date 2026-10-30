import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { HEADER, parseVersionTag } from '@contentops/contracts/api/headers'
import type { Route } from '@contentops/contracts/api/route'
import type { Gender } from '@contentops/contracts/domain/common'
import type { Role } from '@contentops/contracts/domain/people'
import { compile } from '@fastify/proxy-addr'
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { ApiProblem } from './errors'

/** Who calls: a person by session or an agent by bearer token (SPEC §11.1). */
export interface Actor {
  type: 'person' | 'agent'
  id: string
  role: Role
  /** Codes of the models the actor may see: every model for the owner. */
  models: readonly string[]
  /** Name in the feed: «Диана», «Приёмка». */
  name: string
  gender: Gender | null
  /** The session of a person; `null` for an agent. */
  sessionId: string | null
  /** The bearer token of an agent; `null` for a person. */
  tokenId: string | null
}

/** Resolves the caller of a request: a session cookie or a bearer token. */
export type Authenticate = (request: FastifyRequest) => Promise<Actor | null> | Actor | null

/** The model of a `/{model}/…` path after the access check. */
export interface ModelScope {
  id: string
  code: string
  name: string
}

/** Checks the rights of the actor on the route before any handler; gives the model of the path. */
export type Authorize = (input: {
  key: string
  route: Route
  actor: Actor | null
  params: Record<string, string>
}) => Promise<ModelScope | null>

/** What a handler knows about the request besides params, query and body. */
export interface RequestContext {
  /** Returned in `X-Request-Id` and in every error; the journal record carries the same. */
  requestId: string
  /** `area.name` of the table route, also the journal action of a command. */
  route: string
  method: string
  /** Path and query as requested: part of the idempotency digest. */
  url: string
  /** `null` only on public routes (sign-in) or without `authenticate`. */
  actor: Actor | null
  /** Set by `authorize` for paths with `{model}`. */
  model: ModelScope | null
  /** `Idempotency-Key` of a command; enforced together with `idempotency_keys`. */
  idempotencyKey: string | null
  /** Version from `If-Match: "<n>"`; `requireIfMatch` gives 428 when it is absent. */
  ifMatch: number | null
  /** `If-None-Match` of a read: the index resources answer 304 when nothing changed. */
  ifNoneMatch: string | null
  /** Cookies of the request, by name. */
  cookies: Readonly<Record<string, string>>
  /** Adds a header to the answer: `Set-Cookie` of sign-in and sign-out. */
  setHeader(name: string, value: string | string[]): void
  /** Remote address as Fastify sees it behind the trusted proxy. */
  ip: string
  userAgent: string | null
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

/** `a=1; b=2` → `{a: '1', b: '2'}`; broken pairs are skipped. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at < 1) continue
    const name = part.slice(0, at).trim()
    const raw = part.slice(at + 1).trim()
    try {
      cookies[name] = decodeURIComponent(raw)
    } catch {
      // A value that is not URI-encoded is not ours.
    }
  }
  return cookies
}

export async function createRequestContext(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  authenticate: Authenticate | undefined,
): Promise<RequestContext> {
  const headers = request.headers
  const idempotencyKey = readIdempotencyKey(headers[HEADER.idempotencyKey.toLowerCase()])
  const ifMatch = readIfMatch(headers[HEADER.ifMatch.toLowerCase()])
  return {
    requestId: request.id,
    route,
    method: request.method,
    url: request.url,
    actor: authenticate ? await authenticate(request) : null,
    model: null,
    idempotencyKey,
    ifMatch,
    ifNoneMatch: single(headers[HEADER.ifNoneMatch.toLowerCase()])?.trim() || null,
    cookies: parseCookies(single(headers.cookie)),
    setHeader: (name, value) => {
      reply.header(name, value)
    },
    ip: request.ip,
    userAgent: single(headers['user-agent']) ?? null,
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

/** What a read handler returns when the client's copy is current: 304 with the same ETag. */
export class NotModified {
  constructor(readonly etag: string) {}
}

/**
 * A whole resource with a content ETag (SPEC §12.0): 304 when `If-None-Match` names the
 * same content, otherwise the answer with its `ETag`.
 */
export function withContentTag<T>(ctx: RequestContext, etag: string, answer: T): T | NotModified {
  if (ctx.ifNoneMatch === etag) return new NotModified(etag)
  ctx.setHeader(HEADER.etag, etag)
  return answer
}
