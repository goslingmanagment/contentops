import type { Route } from '@contentops/contracts/api/route'
import { type ApiRoutes, apiRoutes } from '@contentops/contracts/api/routes/index'
import { FileBodySchema } from '@contentops/contracts/api/routes/media'
import { z } from 'zod'

/** `area.name` of every route in the table: `objects.get`, `plan.updateNorm`. */
export type RouteKey = {
  [Area in keyof ApiRoutes]: `${Area & string}.${keyof ApiRoutes[Area] & string}`
}[keyof ApiRoutes]

export interface TableEntry {
  key: string
  route: Route
}

export function tableEntries(): TableEntry[] {
  return Object.entries(apiRoutes).flatMap(([area, routes]) =>
    Object.entries(routes).map(([name, route]) => ({
      key: `${area}.${name}`,
      route: route as Route,
    })),
  )
}

export function findRoute(key: string): Route | undefined {
  const [area, name, ...rest] = key.split('.')
  if (!area || !name || rest.length > 0) return undefined
  const routes = (apiRoutes as Record<string, Record<string, Route>>)[area]
  return routes && Object.hasOwn(routes, name) ? routes[name] : undefined
}

export function pathParams(route: Route): string[] {
  return [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string)
}

/** Keys of the query schema; every route of the table declares its query as an object. */
export function queryKeys(route: Route): string[] {
  return route.query instanceof z.ZodObject ? Object.keys(route.query.shape) : []
}

export function takesBody(route: Route): boolean {
  return !(route.body instanceof z.ZodUndefined)
}

export function needsBody(route: Route): boolean {
  return !route.body.safeParse(undefined).success
}

/** Routes that answer with the file itself, not JSON. */
export function isFileRoute(route: Route): boolean {
  return route.response === FileBodySchema
}

export function jsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
}
