import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Base of the fake cloud servers: a real HTTP server on 127.0.0.1 with a request log and
 * failures the test switches on (SPEC §12.0: 429, 5xx, a cut connection, a broken answer).
 */

export type FailureKind =
  | 'rate_limit'
  | 'server_error'
  | 'cut'
  | 'malformed'
  | 'unauthorized'
  | 'forbidden'
  /** The normal answer with its first body byte flipped (a damaged transfer). */
  | 'corrupt'

export interface FailureRule {
  kind: FailureKind
  /** Endpoint name as logged (`/v1/disk/resources`, `files/download`, `download`…); any when omitted. */
  endpoint?: string
  /** How many matching requests fail (default 1). */
  times?: number
  /** `rate_limit`: Retry-After in seconds (default 1). */
  retryAfter?: number
  /** `cut`: body bytes sent before the connection is destroyed (default: half). */
  afterBytes?: number
}

export interface LoggedRequest {
  method: string
  endpoint: string
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  body: string
}

export interface Reply {
  status: number
  headers?: Record<string, string>
  body?: Buffer | string | object
}

export abstract class FakeHttpServer {
  readonly requests: LoggedRequest[] = []
  /** Runs before each answer is built: lets a test change the tree between pages. */
  beforeReply: ((req: LoggedRequest) => void) | null = null
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

  /** Listens on 127.0.0.1; `port` 0 — any free port (a development stack names one). */
  async start(port = 0): Promise<this> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const url = new URL(req.url ?? '/', 'http://fake')
        const endpoint = this.endpointOf(req.method ?? 'GET', url.pathname)
        const logged: LoggedRequest = {
          method: req.method ?? 'GET',
          endpoint,
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
        }
        this.requests.push(logged)
        let reply: Reply
        let cutAt: number | null = null
        const rule = this.#take(endpoint)
        let corrupt = false
        try {
          this.beforeReply?.(logged)
          if (rule && rule.kind !== 'cut' && rule.kind !== 'corrupt') reply = this.failure(rule)
          else {
            reply = this.handle(logged, req)
            if (rule?.kind === 'cut') cutAt = rule.afterBytes ?? -1
            corrupt = rule?.kind === 'corrupt'
          }
        } catch (e) {
          reply = { status: 500, body: { message: `fake server error: ${(e as Error).message}` } }
        }
        let payload = toBuffer(reply.body)
        if (corrupt && payload.length > 0) {
          payload = Buffer.from(payload)
          payload[0] = (payload[0] as number) ^ 0xff
        }
        const headers: Record<string, string> = {
          'content-length': String(payload.length),
          ...(reply.body !== undefined &&
          !Buffer.isBuffer(reply.body) &&
          typeof reply.body === 'object'
            ? { 'content-type': 'application/json' }
            : {}),
          ...reply.headers,
        }
        res.writeHead(reply.status, headers)
        if (cutAt == null) {
          res.end(payload)
          return
        }
        const n = cutAt < 0 ? Math.floor(payload.length / 2) : Math.min(cutAt, payload.length - 1)
        res.write(payload.subarray(0, n), () => {
          // Let the bytes reach the client, then drop the connection mid-body.
          setTimeout(() => res.socket?.destroy(), 20)
        })
      })
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
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

  /** Endpoint name used for logs and failure rules. */
  protected abstract endpointOf(method: string, pathname: string): string

  protected abstract handle(req: LoggedRequest, raw: IncomingMessage): Reply

  /** The provider's answer for an injected failure. */
  protected abstract failure(rule: FailureRule): Reply

  #take(endpoint: string): FailureRule | undefined {
    const rule = this.#rules.find((r) => r.left > 0 && (!r.endpoint || r.endpoint === endpoint))
    if (rule) rule.left--
    return rule
  }
}

function toBuffer(body: Reply['body']): Buffer {
  if (body === undefined) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  return Buffer.from(JSON.stringify(body), 'utf8')
}

/** Serves `bytes` honouring `Range: bytes=N-` (206) or whole (200); 416 past the end. */
export function rangeReply(
  bytes: Buffer,
  range: string | undefined,
  headers: Record<string, string> = {},
): Reply {
  const m = range?.match(/^bytes=(\d+)-(\d*)$/)
  if (!m?.[1]) return { status: 200, headers, body: bytes }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
  if (start >= bytes.length) {
    return { status: 416, headers: { 'content-range': `bytes */${bytes.length}` }, body: '' }
  }
  return {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    body: bytes.subarray(start, end + 1),
  }
}

/** A JSON-looking body that does not parse. */
export const MALFORMED_JSON = '{"items": [{"name": "a", "path": '
