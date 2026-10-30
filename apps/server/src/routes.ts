import { HEADER, versionTag } from '@contentops/contracts/api/headers'
import { NoBodySchema, type Route } from '@contentops/contracts/api/route'
import { apiRoutes } from '@contentops/contracts/api/routes/index'
import { ApiErrorBodySchema } from '@contentops/contracts/domain/errors'
import type { FastifyInstance, HTTPMethods } from 'fastify'
import { z } from 'zod'
import { type Authenticate, createRequestContext } from './context'
import { ApiProblem, invalidRequest } from './errors'
import type { HandlerInput, HandlerRegistry } from './handlers'

/**
 * `{id}` → `:id`; a `:verb` suffix stays literal (`::verb` in find-my-way), and a parameter
 * right before it gets `(^[^:/]+)`, otherwise Fastify 5 reads `:id::verb` as one parameter.
 */
export function toFastifyPath(path: string): string {
  return path
    .replaceAll(':', '::')
    .replace(/\{(\w+)\}(?=::)/g, ':$1(^[^:/]+)')
    .replace(/\{(\w+)\}/g, ':$1')
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string)
}

export interface TableRoute {
  /** `area.name`, also the OpenAPI `operationId`. */
  key: string
  area: string
  name: string
  route: Route
}

export function tableRoutes(): TableRoute[] {
  return Object.entries(apiRoutes).flatMap(([area, routes]) =>
    Object.entries(routes).map(([name, route]) => ({
      key: `${area}.${name}`,
      area,
      name,
      route: route as Route,
    })),
  )
}

/** One Fastify route; several table routes share it when they differ only by query. */
export interface RouteGroup {
  method: HTTPMethods
  url: string
  entries: [TableRoute, ...TableRoute[]]
}

export function groupRoutes(routes: TableRoute[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>()
  for (const entry of routes) {
    const url = toFastifyPath(entry.route.path)
    const id = `${entry.route.method} ${url}`
    const group = groups.get(id)
    if (group) group.entries.push(entry)
    else groups.set(id, { method: entry.route.method, url, entries: [entry] })
  }
  return [...groups.values()]
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Keys of the table routes behind this Fastify route. */
    routes?: string[]
    /** Query shown in OpenAPI when routes of a group differ by query. */
    docQuery?: z.ZodType
  }
}

type LooseHandler = (input: HandlerInput<Route>) => unknown

function handlerOf(handlers: HandlerRegistry, entry: TableRoute): LooseHandler | undefined {
  const areas = handlers as Record<string, Record<string, LooseHandler | undefined> | undefined>
  return areas[entry.area]?.[entry.name]
}

function zodIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

/** The first route of the group whose query fits, as the mock and the client agree. */
function pickByQuery(entries: RouteGroup['entries'], raw: unknown) {
  for (const entry of entries) {
    const parsed = entry.route.query.safeParse(raw)
    if (parsed.success) return { entry, query: parsed.data }
  }
  const first = entries[0].route.query.safeParse(raw)
  throw invalidRequest('querystring', first.success ? [] : zodIssues(first.error))
}

function paramsSchema(path: string) {
  const names = pathParamNames(path)
  if (names.length === 0) return undefined
  return z.object(Object.fromEntries(names.map((name) => [name, z.string().min(1)])))
}

function mergedQuery(entries: RouteGroup['entries']) {
  const shapes = entries.map(({ route }) =>
    route.query instanceof z.ZodObject ? route.query.shape : {},
  )
  return z.object(Object.assign({}, ...shapes)).partial()
}

function responseSchemas(entries: RouteGroup['entries']) {
  const byStatus = new Map<number, z.ZodType[]>()
  for (const { route } of entries) {
    const list = byStatus.get(route.success) ?? []
    if (!list.includes(route.response)) list.push(route.response)
    byStatus.set(route.success, list)
  }
  const result: Record<string, z.ZodType> = {}
  for (const [status, schemas] of byStatus) {
    result[status] =
      schemas.length === 1 ? (schemas[0] as z.ZodType) : z.union(schemas as [z.ZodType, z.ZodType])
  }
  result.default = ApiErrorBodySchema
  return result
}

function versionOf(answer: unknown): number | null {
  if (typeof answer !== 'object' || answer === null || !('version' in answer)) return null
  return typeof answer.version === 'number' ? answer.version : null
}

export interface ApiRouteOptions {
  handlers: HandlerRegistry
  authenticate?: Authenticate
}

/** Registers every route of `apiRoutes`; validation and answers follow the route's schemas. */
export function registerApiRoutes(app: FastifyInstance, options: ApiRouteOptions): void {
  for (const group of groupRoutes(tableRoutes())) {
    const [first] = group.entries
    const single = group.entries.length === 1
    const body = first.route.body
    if (group.entries.some(({ route }) => route.body !== body)) {
      throw new Error(`${group.method} ${first.route.path}: routes of one path differ by body`)
    }
    const params = paramsSchema(first.route.path)
    app.route({
      method: group.method,
      url: group.url,
      schema: {
        operationId: group.entries.map(({ key }) => key).join('+'),
        tags: [first.area],
        ...(params ? { params } : {}),
        ...(single ? { querystring: first.route.query } : {}),
        ...(body === NoBodySchema ? {} : { body }),
        response: responseSchemas(group.entries),
      },
      config: {
        routes: group.entries.map(({ key }) => key),
        ...(single ? {} : { docQuery: mergedQuery(group.entries) }),
      },
      handler: async (request, reply) => {
        const { entry, query } = single
          ? { entry: first, query: request.query }
          : pickByQuery(group.entries, request.query)
        if (body === NoBodySchema && request.body !== undefined) {
          throw invalidRequest('body', [{ path: '', message: 'У этого вызова нет тела' }])
        }
        const ctx = await createRequestContext(request, options.authenticate)
        const handler = handlerOf(options.handlers, entry)
        if (!handler) {
          throw new ApiProblem('not_implemented', 'Сервер ещё не умеет этот вызов', {
            route: entry.key,
          })
        }
        const answer = await handler({
          params: request.params as Record<string, string>,
          query,
          body: request.body,
          ctx,
        })
        reply.code(entry.route.success)
        const version = entry.route.versioned ? versionOf(answer) : null
        if (version !== null) reply.header(HEADER.etag, versionTag(version))
        return answer
      },
    })
  }
}
