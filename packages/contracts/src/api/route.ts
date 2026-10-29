import { z } from 'zod'

/**
 * A route is the single description of one API call: method, path template, query,
 * body and answer schemas. The client builds requests from it, the mock matches and
 * validates against it, and the OpenAPI document will be generated from the same objects.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type ParamNames<Path extends string> = Path extends `${string}{${infer Name}}${infer Rest}`
  ? Name | ParamNames<Rest>
  : never

export type PathParams<Path extends string> = { [Name in ParamNames<Path>]: string }

export const NoQuerySchema = z.object({})
export const NoBodySchema = z.undefined()

export interface Route<
  Path extends string = string,
  Query extends z.ZodType = z.ZodType,
  Body extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
> {
  method: HttpMethod
  path: Path
  query: Query
  body: Body
  response: Response
  /** 200 for plain answers, 201 for created records, 202 for long operations. */
  success: 200 | 201 | 202
  /** The record carries a version: changes need `If-Match`, reads give an `ETag`. */
  versioned: boolean
}

export function defineRoute<
  const Path extends string,
  Response extends z.ZodType,
  Query extends z.ZodType = typeof NoQuerySchema,
  Body extends z.ZodType = typeof NoBodySchema,
>(definition: {
  method: HttpMethod
  path: Path
  response: Response
  query?: Query
  body?: Body
  success?: 200 | 201 | 202
  versioned?: boolean
}): Route<Path, Query, Body, Response> {
  return {
    method: definition.method,
    path: definition.path,
    // A missing schema falls back to the default type argument, which TS cannot see here.
    query: (definition.query ?? NoQuerySchema) as Query,
    body: (definition.body ?? NoBodySchema) as Body,
    response: definition.response,
    success: definition.success ?? 200,
    versioned: definition.versioned ?? false,
  }
}

export function buildPath<Path extends string>(path: Path, params: PathParams<Path>): string {
  const values = params as Record<string, string>
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`Нет параметра пути ${name} для ${path}`)
    return encodeURIComponent(value)
  })
}

const REGEX_SPECIAL = /[.*+?^$()|[\]\\]/g

/** Matches a concrete path against a template; `{id}:accept` keeps the action suffix literal. */
export function matchPath(template: string, path: string): Record<string, string> | null {
  const names: string[] = []
  const pattern = template
    .replace(REGEX_SPECIAL, '\\$&')
    .replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name)
      return '([^/:]+)'
    })
  const match = new RegExp(`^${pattern}$`).exec(path)
  if (!match) return null
  const params: Record<string, string> = {}
  names.forEach((name, index) => {
    params[name] = decodeURIComponent(match[index + 1] ?? '')
  })
  return params
}

/** Query value types a route may declare: strings, numbers, booleans and repeated strings. */
type QueryValue = string | number | boolean | readonly string[] | null | undefined

export function toSearchParams(query: Record<string, QueryValue>): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item)
    } else if (typeof value === 'boolean') {
      params.append(key, value ? '1' : '0')
    } else {
      params.append(key, String(value))
    }
  }
  return params
}

/** Repeated keys become arrays, single keys stay strings; schemas normalise the rest. */
export function fromSearchParams(params: URLSearchParams): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  params.forEach((value, key) => {
    const existing = result[key]
    if (existing === undefined) result[key] = value
    else result[key] = Array.isArray(existing) ? [...existing, value] : [existing, value]
  })
  return result
}

/** A query flag: `1`/`0` on the wire, a boolean in code. */
export const QueryFlagSchema = z
  .union([z.boolean(), z.enum(['0', '1'])])
  .transform((value) => value === true || value === '1')

/** A repeatable query parameter: `where=lora-2:no&where=lora-1:yes`. */
export const QueryListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : [value]))
