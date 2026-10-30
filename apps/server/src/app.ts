import { HEADER } from '@contentops/contracts/api/headers'
import { fromSearchParams } from '@contentops/contracts/api/route'
import fastifySwagger from '@fastify/swagger'
import Fastify, {
  type FastifyReply,
  type FastifyRequest,
  type FastifySerializerCompiler,
  LogController,
} from 'fastify'
import {
  ResponseSerializationError,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod'
import type { Logger } from 'pino'
import type { z } from 'zod'
import { type Authenticate, type Authorize, requestIdGenerator } from './context'
import { ApiProblem, toErrorReply } from './errors'
import type { HandlerRegistry } from './handlers'
import { type HealthCheck, mountsCheck, registerHealth, volumesCheck } from './health'
import { createLogger } from './logger'
import { swaggerOptions } from './openapi'
import { type RecordFailure, registerApiRoutes } from './routes'

export interface AppDeps {
  /** Handlers by area and route name; the rest of the table answers 501. */
  handlers?: HandlerRegistry
  /** Checks of `/healthz` besides the mounts: the DB ping and the like. */
  checks?: Record<string, HealthCheck>
  /** `REQUIRE_MOUNTS`: each path must be a mount point for a green `/healthz`. */
  requireMounts?: readonly string[]
  /** `REQUIRE_VOLUMES`: each path must carry the volume mark of `ops/up.sh`. */
  requireVolumes?: readonly string[]
  /** `TRUSTED_PROXY`: only these peers may set `X-Forwarded-*` and `X-Request-Id`. */
  trustedProxy?: readonly string[]
  authenticate?: Authenticate
  /** Rights on the route and the model of the path; without it every call is let through. */
  authorize?: Authorize
  recordFailure?: RecordFailure
  logger?: Logger
}

/**
 * Handlers return the answer before its schema, as in the mock: the route's schema parses it
 * and the parsed value goes out. A mismatch is a 500, never a half-valid answer.
 */
const parsingSerializer: FastifySerializerCompiler<z.ZodType> =
  ({ schema, method, url }) =>
  (data) => {
    const parsed = schema.safeParse(data)
    if (!parsed.success) throw new ResponseSerializationError(method, url, { cause: parsed.error })
    return JSON.stringify(parsed.data)
  }

function sendError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const { status, body, retryAfterSeconds } = toErrorReply(error, request.id)
  // A refusal is an answer; anything else that ends in 5xx is a fault worth a stack.
  if (status >= 500 && !(error instanceof ApiProblem))
    request.log.error({ err: error }, 'request failed')
  else request.log.info({ code: body.code, details: body.details }, body.message)
  reply.removeHeader(HEADER.etag)
  reply.header(HEADER.requestId, request.id)
  if (retryAfterSeconds !== null) reply.header(HEADER.retryAfter, String(retryAfterSeconds))
  return reply.code(status).send(body)
}

export function buildApp(deps: AppDeps = {}) {
  const trustedProxy = [...(deps.trustedProxy ?? ['loopback'])]
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    genReqId: requestIdGenerator(trustedProxy),
    requestIdHeader: false,
    trustProxy: trustedProxy,
    exposeHeadRoutes: false,
    routerOptions: {
      // The client encodes with `toSearchParams`; repeated keys become arrays the same way.
      querystringParser: (search) => fromSearchParams(new URLSearchParams(search)),
    },
    frameworkErrors: (error, request, reply) => {
      sendError(error, request, reply)
    },
  }).withTypeProvider<ZodTypeProvider>()

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(parsingSerializer)
  app.addHook('onRequest', async (request, reply) => {
    reply.header(HEADER.requestId, request.id)
  })
  app.setErrorHandler((error, request, reply) => sendError(error, request, reply))
  app.setNotFoundHandler((request, reply) =>
    sendError(new ApiProblem('not_found', 'Нет такого адреса'), request, reply),
  )

  const checks: Record<string, HealthCheck> = { ...deps.checks }
  if (deps.requireMounts && deps.requireMounts.length > 0) {
    checks.mounts = mountsCheck(deps.requireMounts)
  }
  if (deps.requireVolumes && deps.requireVolumes.length > 0) {
    checks.volumes = volumesCheck(deps.requireVolumes)
  }

  app.register(fastifySwagger, swaggerOptions)
  app.register(async (api) => {
    registerApiRoutes(api, {
      handlers: deps.handlers ?? {},
      authenticate: deps.authenticate,
      authorize: deps.authorize,
      recordFailure: deps.recordFailure,
    })
    api.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())
    registerHealth(api, checks)
  })
  return app
}

export type App = ReturnType<typeof buildApp>

/** The OpenAPI 3.1 document of the route table, as `/api/v1/openapi.json` serves it. */
export async function openApiDocument(): Promise<unknown> {
  const app = buildApp({ logger: createLogger({ level: 'silent' }) })
  await app.ready()
  const document = app.swagger()
  await app.close()
  return document
}

export function openApiText(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
