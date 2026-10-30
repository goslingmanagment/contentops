import type { Route } from '@contentops/contracts/api/route'
import { type Alias, aliases } from './aliases'
import { isFileRoute, jsonSchema, pathParams, queryKeys, tableEntries, takesBody } from './table'

export const DEFAULT_URL = 'http://127.0.0.1:3000'

export const USAGE = `contentops — the ContentOps API from the command line (SPEC §11.2)

usage:
  contentops <area> <name> [--<param> value …] [--body @file.json | --body - | --body '<json>']
             [--json] [--wait [--timeout <s>]] [--if-match N] [--idempotency-key K] [--out <file>]
  contentops <area> <name> --help    path params, query keys and the body schema of a route
  contentops routes [--json]         every route: area.name, method, path

  Path params and query keys are flags named as in the route (--model lora --id PPV-073);
  a query key may repeat. stdout gets the result JSON only (--json: one line), stderr the rest.

env:
  CONTENTOPS_URL     server address without /api/v1 (default ${DEFAULT_URL})
  CONTENTOPS_TOKEN   agent token, sent as Authorization: Bearer

exit codes:
  0   success, or accepted (202) without --wait
  1   domain error: 400, 404, 409, 412, 422, 428, 429, a failed operation
  2   access or connection: 401, 403, 5xx, network, --wait timeout
  64  usage: the command cannot become a request
`

function line(key: string, route: Route, width: number): string {
  return `  ${key.padEnd(width)}  ${route.method.padEnd(6)} ${route.path}`
}

export function routesText(json: boolean): string {
  const entries = tableEntries()
  const aliasEntries = Object.entries(aliases)
  if (json) {
    return JSON.stringify({
      routes: entries.map(({ key, route }) => ({
        route: key,
        method: route.method,
        path: route.path,
      })),
      aliases: aliasEntries.map(([key, alias]) => ({
        alias: key,
        route: alias.route,
        summary: alias.summary,
      })),
    })
  }
  const width = Math.max(
    ...entries.map(({ key }) => key.length),
    ...aliasEntries.map(([k]) => k.length),
  )
  const lines = ['routes:', ...entries.map(({ key, route }) => line(key, route, width))]
  if (aliasEntries.length > 0) {
    lines.push('', 'aliases:')
    for (const [key, alias] of aliasEntries)
      lines.push(`  ${key.padEnd(width)}  → ${alias.route}: ${alias.summary}`)
  }
  return `${lines.join('\n')}\n`
}

function routeNotes(route: Route): string[] {
  const notes: string[] = []
  if (route.method !== 'GET')
    notes.push(
      'changing call: sends an Idempotency-Key (printed to stderr; --idempotency-key repeats an intent)',
    )
  if (route.versioned && route.method !== 'GET')
    notes.push('versioned record: the change needs --if-match <version>')
  if (route.success === 202)
    notes.push('answers 202 with an operation: --wait waits for its result')
  if (isFileRoute(route)) notes.push('answers with a file: --out <path> saves it')
  return notes
}

export function routeHelp(key: string, route: Route, json: boolean): string {
  const params = pathParams(route)
  const query = queryKeys(route)
  const body = takesBody(route) ? jsonSchema(route.body) : null
  if (json) {
    return JSON.stringify({
      route: key,
      method: route.method,
      path: route.path,
      success: route.success,
      versioned: route.versioned,
      params,
      query: query.length > 0 ? jsonSchema(route.query) : null,
      body,
      file: isFileRoute(route),
    })
  }
  const flags = (names: string[]) => (names.length > 0 ? names.map((n) => `--${n}`).join(' ') : '—')
  const lines = [
    `${key}: ${route.method} ${route.path} → ${route.success}`,
    `  path params: ${flags(params)}`,
    `  query keys:  ${flags(query)}`,
    ...routeNotes(route).map((note) => `  ${note}`),
  ]
  if (query.length > 0)
    lines.push('', 'query (JSON Schema):', JSON.stringify(jsonSchema(route.query), null, 2))
  lines.push(
    '',
    body === null ? 'body: none' : `body (JSON Schema):\n${JSON.stringify(body, null, 2)}`,
  )
  return `${lines.join('\n')}\n`
}

export function aliasHelp(key: string, alias: Alias, json: boolean): string {
  if (json) {
    return JSON.stringify({
      alias: key,
      route: alias.route,
      summary: alias.summary,
      flags: alias.flags,
    })
  }
  const lines = [`${key}: ${alias.summary}`, `  calls ${alias.route}`, '  flags:']
  for (const [name, help] of Object.entries(alias.flags)) lines.push(`    --${name}  ${help}`)
  return `${lines.join('\n')}\n`
}
