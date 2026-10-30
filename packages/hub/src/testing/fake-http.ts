import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Base of the fake Hub: a real HTTP server on 127.0.0.1 with a request log and failures
 * the test switches on (SPEC §12.0: 429, 5xx, a cut connection, a broken answer).
 */

export type FailureKind =
  | 'rate_limit'
  | 'server_error'
  /** The normal answer, cut after half of its body. */
  | 'cut'
  /** A 200 whose body is not JSON. */
  | 'malformed'
  | 'unauthorized'
  | 'forbidden'
  /** The command is carried out, then the connection drops before any answer. */
  | 'lost_answer'

export interface FailureRule {
  kind: FailureKind
  /** Endpoint name (`dataset`, `publications.approve`…); any when omitted. */
  endpoint?: string
  /** How many matching requests fail (default 1). */
  times?: number
  /** `rate_limit`: Retry-After in seconds (default 1). */
  retryAfter?: number
}

export interface LoggedRequest {
  method: string
  endpoint: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: Buffer
  /** The body parsed as JSON, or undefined. */
  json: unknown
}

export interface Reply {
  status: number
  headers?: Record<string, string>
  body?: string | object
}

/** A JSON-looking body that does not parse. */
export const MALFORMED_JSON = '{"items": [{"key": "a", "fields": '

export abstract class FakeHttpServer {
  readonly requests: LoggedRequest[] = []
  #server: Server | null = null
  #rules: (FailureRule & { left: number })[] = []
  #url = ''

  get url(): string {
    return this.#url
  }

  /** The next matching request(s) fail this way. */
  fail(kind: FailureKind, rule: Omit<FailureRule, 'kind'> = {}): this {
    this.#rules.push({ kind, ...rule, left: rule.times ?? 1 })
    return this
  }

  clearFailures(): void {
    this.#rules = []
  }

  /** Requests to one endpoint. */
  calls(endpoint: string): LoggedRequest[] {
    return this.requests.filter((r) => r.endpoint === endpoint)
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const url = new URL(req.url ?? '/', 'http://fake')
        const method = req.method ?? 'GET'
        let json: unknown
        try {
          json = body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined
        } catch {
          json = undefined
        }
        const logged: LoggedRequest = {
          method,
          endpoint: this.endpointOf(method, url.pathname),
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          json,
        }
        this.requests.push(logged)
        const rule = this.#take(logged.endpoint)
        let reply: Reply
        if (rule && rule.kind !== 'cut' && rule.kind !== 'lost_answer') {
          reply = this.failure(rule)
        } else {
          try {
            reply = this.handle(logged)
          } catch (e) {
            reply = {
              status: 500,
              body: { error: 'internal_error', message: (e as Error).message, statusCode: 500 },
            }
          }
        }
        if (rule?.kind === 'lost_answer') {
          res.socket?.destroy()
          return
        }
        const payload = Buffer.from(
          reply.body === undefined
            ? ''
            : typeof reply.body === 'string'
              ? reply.body
              : JSON.stringify(reply.body),
          'utf8',
        )
        res.writeHead(reply.status, {
          'content-length': String(payload.length),
          'content-type': 'application/json',
          ...reply.headers,
        })
        if (rule?.kind !== 'cut') {
          res.end(payload)
          return
        }
        res.write(payload.subarray(0, Math.floor(payload.length / 2)), () => {
          // Let the bytes reach the client, then drop the connection mid-body.
          setTimeout(() => res.socket?.destroy(), 20)
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.#server = server
    this.#url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    const server = this.#server
    if (!server) return
    this.#server = null
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  protected abstract endpointOf(method: string, pathname: string): string

  protected abstract handle(req: LoggedRequest): Reply

  protected failure(rule: FailureRule): Reply {
    const error = (status: number, code: string, headers?: Record<string, string>): Reply => ({
      status,
      ...(headers ? { headers } : {}),
      body: { error: code, message: `fake ${code}`, statusCode: status },
    })
    switch (rule.kind) {
      case 'rate_limit':
        return error(429, 'rate_limit_exceeded', { 'retry-after': String(rule.retryAfter ?? 1) })
      case 'server_error':
        return error(503, 'service_unavailable')
      case 'unauthorized':
        return error(401, 'unauthorized')
      case 'forbidden':
        return error(403, 'forbidden')
      case 'malformed':
        return { status: 200, body: MALFORMED_JSON }
      default:
        return error(500, 'internal_error')
    }
  }

  #take(endpoint: string): FailureRule | undefined {
    const rule = this.#rules.find((r) => r.left > 0 && (!r.endpoint || r.endpoint === endpoint))
    if (rule) rule.left--
    return rule
  }
}
