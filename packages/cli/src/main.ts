import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createApiClient, errorFrom, type FetchLike } from '@contentops/contracts/api/client'
import { ApiError } from '@contentops/contracts/api/errors'
import { newIdempotencyKey } from '@contentops/contracts/api/idempotency-key'
import { matchPath, type Route } from '@contentops/contracts/api/route'
import { apiRoutes } from '@contentops/contracts/api/routes/index'
import { type Operation, OperationAcceptedSchema } from '@contentops/contracts/domain/operations'
import { z } from 'zod'
import { aliases, type RouteCall } from './aliases'
import { type ParsedArgs, parseArgs, takeOne, UsageError } from './args'
import { aliasHelp, DEFAULT_URL, routeHelp, routesText, USAGE } from './help'
import { type Io, processIo } from './io'
import { findRoute, isFileRoute, needsBody, pathParams, queryKeys, takesBody } from './table'

/** Exit codes (SPEC §11.2); 64 is EX_USAGE of sysexits. */
export const EXIT = { ok: 0, domain: 1, access: 2, usage: 64 } as const

/** 401, 403 and 5xx are access or connection; every other error answer is the domain's. */
export function exitCodeForStatus(status: number): number {
  return status === 401 || status === 403 || status >= 500 ? EXIT.access : EXIT.domain
}

const DEFAULT_WAIT_SECONDS = 600
const POLL_FIRST_MS = 500
const POLL_MAX_MS = 5000

type FlagMap = Map<string, string[]>

interface RouteInput {
  params: Record<string, string>
  query: Record<string, string | string[]>
}

/** Runs one command; the answer is the exit code. */
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  let json = argv.includes('--json')
  try {
    const args = parseArgs(argv)
    json = args.json
    return await run(args, io)
  } catch (error) {
    return fail(error, io, json)
  }
}

function emit(io: Io, text: string): void {
  io.stdout(text.endsWith('\n') ? text : `${text}\n`)
}

function commandKey(words: string[]): string {
  const [first, second, extra] = words
  if (extra !== undefined) throw new UsageError(`unexpected argument ${extra}`)
  if (first === undefined) throw new UsageError('no command')
  if (second !== undefined) return `${first}.${second}`
  if (first.includes('.')) return first
  const names = Object.keys((apiRoutes as Record<string, object>)[first] ?? {})
  const aliasNames = Object.keys(aliases)
    .filter((key) => key.startsWith(`${first}.`))
    .map((key) => key.slice(first.length + 1))
  const all = [...names, ...aliasNames]
  throw new UsageError(
    all.length > 0
      ? `name the route: contentops ${first} <${all.join('|')}>`
      : `unknown command ${first}; see contentops routes`,
  )
}

async function run(args: ParsedArgs, io: Io): Promise<number> {
  const [first, ...rest] = args.words
  if (first === undefined || first === 'help') {
    if (rest.length === 0) {
      emit(io, `${USAGE}\n${routesText(false)}`)
      return EXIT.ok
    }
    return run({ ...args, words: rest, help: true }, io)
  }
  if (first === 'routes') {
    if (rest.length > 0) throw new UsageError(`unexpected argument ${rest[0]}`)
    emit(io, routesText(args.json))
    return EXIT.ok
  }
  const key = commandKey(args.words)
  const alias = aliases[key]
  const tableRoute = findRoute(key)
  if (!alias && !tableRoute) throw new UsageError(`unknown command ${key}; see contentops routes`)
  if (args.help) {
    emit(
      io,
      alias ? aliasHelp(key, alias, args.json) : routeHelp(key, tableRoute as Route, args.json),
    )
    return EXIT.ok
  }
  return new Session(args, io).command(key)
}

class Session {
  private readonly flags: FlagMap
  private readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly client: ReturnType<typeof createApiClient>
  private readonly bodySource: string | undefined
  private readonly timeoutMs: number
  private readonly ifMatch: number | undefined
  private readonly idempotencyKey: string | undefined
  private readonly out: string | undefined

  constructor(
    private readonly args: ParsedArgs,
    private readonly io: Io,
  ) {
    this.flags = new Map(args.flags)
    this.bodySource = takeOne(this.flags, 'body')
    const timeout = takeOne(this.flags, 'timeout')
    const ifMatch = takeOne(this.flags, 'if-match')
    this.idempotencyKey = takeOne(this.flags, 'idempotency-key')
    this.out = takeOne(this.flags, 'out')
    if (timeout !== undefined && !args.wait) throw new UsageError('--timeout goes with --wait')
    const seconds = timeout === undefined ? DEFAULT_WAIT_SECONDS : Number(timeout)
    if (!(seconds > 0)) throw new UsageError(`--timeout must be seconds above zero: ${timeout}`)
    this.timeoutMs = seconds * 1000
    if (ifMatch !== undefined && !/^\d+$/.test(ifMatch))
      throw new UsageError(`--if-match must be a version number: ${ifMatch}`)
    this.ifMatch = ifMatch === undefined ? undefined : Number(ifMatch)

    this.baseUrl = (io.env.CONTENTOPS_URL || DEFAULT_URL).replace(/\/+$/, '')
    const token = io.env.CONTENTOPS_TOKEN
    let warned = false
    this.fetch = (url, init) => {
      const headers = new Headers(init.headers)
      if (token) headers.set('Authorization', `Bearer ${token}`)
      else if (!warned) {
        io.stderr('warning: CONTENTOPS_TOKEN is not set\n')
        warned = true
      }
      return io.fetch(url, { ...init, headers })
    }
    this.client = createApiClient(this.fetch, { baseUrl: this.baseUrl })
  }

  async command(key: string): Promise<number> {
    let routeKey = key
    let routeFlags = this.flags
    let aliasCall: RouteCall | undefined
    const alias = aliases[key]
    if (alias) {
      for (const name of this.flags.keys())
        if (!Object.hasOwn(alias.flags, name))
          throw new UsageError(`unknown flag --${name} for ${key}; see contentops ${key} --help`)
      aliasCall = await alias.toRoute(Object.fromEntries(this.flags), {
        read: (target, flags) => this.read(target, toFlagMap(flags)),
      })
      routeKey = alias.route
      routeFlags = toFlagMap(aliasCall.flags)
    }
    const route = findRoute(routeKey)
    if (!route) throw new UsageError(`unknown route ${routeKey}`)
    const input = routeInput(routeKey, route, routeFlags)
    const body = await this.body(routeKey, route, aliasCall)

    if (isFileRoute(route)) return this.download(routeKey, route, input)
    // `--wait` on a status address follows an operation started earlier.
    const status = STATUS_ROUTES.find(([, statusRoute]) => statusRoute === route)
    if (status && this.args.wait) return this.wait({ key: status[0], route, params: input.params })
    if (this.out !== undefined)
      throw new UsageError('--out is only for routes that answer with a file')

    let idempotencyKey: string | undefined
    // «Войти» carries no key (SPEC §11.2); every other change does.
    if (route.method !== 'GET' && route !== apiRoutes.auth.signIn) {
      idempotencyKey = this.idempotencyKey ?? newIdempotencyKey()
      this.io.stderr(`idempotency-key: ${idempotencyKey}\n`)
    }
    const result = await this.client.call(route, {
      ...input,
      ...(body === undefined ? {} : { body }),
      ...(this.ifMatch === undefined ? {} : { ifMatch: this.ifMatch }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    } as never)
    const accepted = OperationAcceptedSchema.safeParse(result)
    if (accepted.success) {
      if (this.args.wait) return this.wait(statusRoute(accepted.data.status_url))
      this.io.stderr(
        `accepted: operation ${accepted.data.operation_id} (${accepted.data.status_url}); --wait waits for it\n`,
      )
    }
    this.print(result)
    return EXIT.ok
  }

  private print(value: unknown): void {
    this.io.stdout(
      this.args.json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`,
    )
  }

  private async read(key: string, flags: FlagMap): Promise<unknown> {
    const route = findRoute(key)
    if (route?.method !== 'GET') throw new Error(`alias lookup ${key} is not a read`)
    return this.client.call(route, routeInput(key, route, flags) as never)
  }

  private async body(key: string, route: Route, aliasCall: RouteCall | undefined) {
    let body: unknown
    if (aliasCall && 'body' in aliasCall) {
      if (this.bodySource !== undefined) throw new UsageError(`--body is not taken by this alias`)
      body = aliasCall.body
    } else if (this.bodySource !== undefined) {
      body = await loadBody(this.bodySource, this.io)
    }
    if (body !== undefined && !takesBody(route)) throw new UsageError(`${key} takes no body`)
    if (body === undefined && needsBody(route))
      throw new UsageError(
        `${key} needs --body @file.json | - | '<json>'; its schema: contentops ${key} --help`,
      )
    return body
  }

  private async download(key: string, route: Route, input: RouteInput): Promise<number> {
    if (this.out === undefined)
      throw new UsageError(`${key} answers with a file: pass --out <path>`)
    const response = await this.fetch(this.client.url(route, input as never), {
      method: 'GET',
      headers: { Accept: '*/*' },
    })
    if (!response.ok) throw await errorFrom(response)
    const bytes = Buffer.from(await response.arrayBuffer())
    const file = resolve(this.io.cwd, this.out)
    await writeFile(file, bytes)
    this.print({
      file,
      size_bytes: bytes.length,
      content_type: response.headers.get('content-type'),
    })
    return EXIT.ok
  }

  /** Polls the status address of an operation until it is done or failed. */
  private async wait({ key, route, params }: StatusAddress): Promise<number> {
    const deadline = this.io.now() + this.timeoutMs
    let delay = POLL_FIRST_MS
    let shown = ''
    let operation: Operation | null = null
    for (;;) {
      let pause = delay
      try {
        operation = (await this.client.call(route, { params } as never)) as Operation
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 429)) throw error
        pause = Math.max(delay, (error.retryAfterSeconds ?? 1) * 1000)
      }
      if (operation) {
        const progress = `${operation.label} · ${Math.round(operation.progress * 100)}%`
        if (progress !== shown) this.io.stderr(`operation ${operation.id}: ${progress}\n`)
        shown = progress
        if (operation.state === 'done') {
          this.print(operation)
          return EXIT.ok
        }
        if (operation.state === 'failed') {
          this.print(operation)
          const error = operation.error
          this.io.stderr(`${error?.code ?? 'failed'}: ${error?.message ?? operation.label}\n`)
          return EXIT.domain
        }
      }
      if (this.io.now() + pause > deadline) {
        if (operation) this.print(operation)
        const flags = Object.entries(params).map(([name, value]) => `--${name} ${value}`)
        this.io.stderr(
          `timeout: operation ${params.operation} is still running after ${this.timeoutMs / 1000} s; ` +
            `follow it with: contentops ${key.replace('.', ' ')} ${flags.join(' ')} --wait\n`,
        )
        return EXIT.access
      }
      await this.io.sleep(pause)
      delay = Math.min(delay * 1.5, POLL_MAX_MS)
    }
  }
}

function toFlagMap(flags: RouteCall['flags']): FlagMap {
  return new Map(
    Object.entries(flags).map(([name, value]) => [
      name,
      typeof value === 'string' ? [value] : [...value],
    ]),
  )
}

/** Path params (each once) and query keys (may repeat) of a route; other flags are usage errors. */
function routeInput(key: string, route: Route, flags: FlagMap): RouteInput {
  const names = pathParams(route)
  const keys = new Set(queryKeys(route))
  const params: Record<string, string> = {}
  const query: Record<string, string | string[]> = {}
  for (const [name, values] of flags) {
    if (names.includes(name)) {
      if (values.length > 1) throw new UsageError(`--${name} is given more than once`)
      params[name] = values[0] as string
    } else if (keys.has(name)) {
      query[name] = values.length === 1 ? (values[0] as string) : values
    } else {
      throw new UsageError(`unknown flag --${name} for ${key}; see contentops ${key} --help`)
    }
  }
  const missing = names.filter((name) => params[name] === undefined)
  if (missing.length > 0)
    throw new UsageError(`${key} needs ${missing.map((name) => `--${name}`).join(' ')}`)
  return { params, query }
}

async function loadBody(source: string, io: Io): Promise<unknown> {
  let text: string
  let from: string
  if (source === '-') {
    text = await io.readStdin()
    from = 'stdin'
  } else if (source.startsWith('@')) {
    from = resolve(io.cwd, source.slice(1))
    try {
      text = await readFile(from, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read ${from}: ${(error as Error).message}`)
    }
  } else {
    text = source
    from = '--body'
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${from} is not JSON: ${(error as Error).message}`)
  }
}

interface StatusAddress {
  key: string
  route: Route
  params: Record<string, string>
}

/** Where operations report their state; `admin` first, the model template would take it. */
const STATUS_ROUTES: [string, Route][] = [
  ['admin.operation', apiRoutes.admin.operation],
  ['operations.get', apiRoutes.operations.get],
]

/** The `status_url` of a 202 answer as a route of the table. */
function statusRoute(statusUrl: string): StatusAddress {
  const path = new URL(statusUrl, 'http://status.invalid').pathname
  for (const [key, route] of STATUS_ROUTES) {
    const params = matchPath(route.path, path)
    if (params) return { key, route, params }
  }
  throw new Error(`unknown status address of an operation: ${statusUrl}`)
}

function fail(error: unknown, io: Io, json: boolean): number {
  if (error instanceof UsageError) {
    io.stderr(`usage: ${error.message}\n`)
    return EXIT.usage
  }
  if (error instanceof ApiError) {
    if (json) io.stdout(`${JSON.stringify(error.body)}\n`)
    const retry =
      error.retryAfterSeconds === null ? '' : ` (retry after ${error.retryAfterSeconds} s)`
    io.stderr(`${error.body.code}: ${error.body.message}${retry}\n`)
    return exitCodeForStatus(error.status)
  }
  if (error instanceof z.ZodError) {
    io.stderr(
      `the answer does not match the contract of this copy of the repo (update it): ${z.prettifyError(error)}\n`,
    )
    return EXIT.access
  }
  const message = error instanceof Error ? error.message : String(error)
  const cause =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  io.stderr(`${error instanceof TypeError ? 'connection' : 'error'}: ${message}${cause}\n`)
  return EXIT.access
}
