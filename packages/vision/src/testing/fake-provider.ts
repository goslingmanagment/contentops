import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createAnthropicProvider } from '../anthropic.ts'
import { createOpenAiProvider } from '../openai.ts'
import type { ProviderName, Stage, VisionProvider } from '../types.ts'

/**
 * The providers on a fake server (SPEC §12.0: external systems are fake HTTP servers in the
 * tests, no live keys, no network): OpenAI's `POST /v1/responses` and Anthropic's
 * `POST /v1/messages` on 127.0.0.1, every request logged with its raw body. By default each
 * stage gets a valid answer; a test scripts refusals and failures for the next requests.
 */

export const FAKE_KEY = 'fake-provider-key'

export type Scripted =
  /** HTTP 200 with the provider's own refusal (`stop_reason: refusal`, a `refusal` part). */
  | 'refuse'
  /** HTTP 400 of the policy. */
  | 'policy_error'
  /** HTTP 200 whose text is a refusal in words instead of JSON. */
  | 'text_refusal'
  /** HTTP 200 with a JSON that breaks the schema. */
  | 'broken'
  | 'unauthorized'
  | 'rate_limited'
  | 'server_error'
  /** The request is read, then the connection drops before any answer. */
  | 'lost_answer'
  /** An answer of the stage the test gives itself. */
  | { answer: Record<string, unknown> }

export interface FakeRequest {
  provider: ProviderName
  path: string
  headers: IncomingHttpHeaders
  /** The raw bytes as they came: what the composition checks look into. */
  raw: Buffer
  json: Record<string, unknown> | null
  /** The context JSON of the request (its first text part). */
  context: Record<string, unknown> | null
  stage: Stage | null
}

const USAGE = { input_tokens: 1200, output_tokens: 300 }

function contextOf(provider: ProviderName, json: Record<string, unknown> | null) {
  const holder =
    provider === 'openai'
      ? (json?.input as { content?: { text?: unknown }[] }[] | undefined)?.[0]
      : (json?.messages as { content?: { text?: unknown }[] }[] | undefined)?.[0]
  const text = holder?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

/** A valid answer of a stage for the request's frames and fields. */
export function defaultAnswer(stage: Stage, context: Record<string, unknown> | null) {
  const frames = (context?.frames as { n: number }[] | undefined) ?? []
  switch (stage) {
    case 'observe':
      return {
        observations: frames.map((frame) => ({
          n: frame.n,
          facts: [`frame ${frame.n}: a room with soft light`, 'lace lingerie'],
        })),
      }
    case 'aggregate': {
      const fields = (context?.fields as string[] | undefined) ?? []
      const want = (field: string) => fields.includes(field)
      return {
        title: want('title') ? 'Кружево у окна' : null,
        title_en: want('title_en') ? 'Lace by the window' : null,
        tags: want('tags') ? ['lace', 'tender', 'window-light'] : null,
        description: want('description') ? 'Мягкий свет, кружевное бельё, спокойный танец.' : null,
        chronology: want('chronology')
          ? frames.slice(0, 2).map((frame, index) => ({
              n: frame.n,
              text: index === 0 ? 'у окна' : 'танец',
            }))
          : null,
        facts: 'A calm dance in lace lingerie by a bright window.',
        declined: [],
      }
    }
    case 'texts':
      return {
        wall: 'Soft light, lace and a slow dance — come closer.',
        message: 'I made something calm and pretty for you: lace, a window and a slow dance.',
        declined: [],
      }
  }
}

export class FakeProvider {
  readonly requests: FakeRequest[] = []
  #server: Server | null = null
  #url = ''
  #script: Scripted[] = []

  get url(): string {
    return this.#url
  }

  /** The next requests get these outcomes, one each, in order; then the defaults again. */
  next(...outcomes: Scripted[]): this {
    this.#script.push(...outcomes)
    return this
  }

  /** Requests to one provider, oldest first. */
  of(provider: ProviderName): FakeRequest[] {
    return this.requests.filter((request) => request.provider === provider)
  }

  /** An adapter of `provider` that talks to this server. */
  provider(name: ProviderName): VisionProvider {
    return name === 'openai'
      ? createOpenAiProvider({ apiKey: FAKE_KEY, baseUrl: `${this.#url}/v1` })
      : createAnthropicProvider({ apiKey: FAKE_KEY, baseUrl: this.#url })
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        const path = new URL(req.url ?? '/', 'http://fake').pathname
        const provider: ProviderName = path.endsWith('/responses') ? 'openai' : 'anthropic'
        let json: Record<string, unknown> | null = null
        try {
          json = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        } catch {
          json = null
        }
        const context = contextOf(provider, json)
        const stage = (context?.stage as Stage | undefined) ?? null
        this.requests.push({ provider, path, headers: req.headers, raw, json, context, stage })
        const scripted = this.#script.shift()
        if (scripted === 'lost_answer') {
          res.socket?.destroy()
          return
        }
        const reply = this.#reply(provider, stage ?? 'observe', context, scripted)
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(provider === 'openai' ? { 'x-request-id': `req_fake_${this.requests.length}` } : {}),
          ...(provider === 'anthropic' ? { 'request-id': `req_fake_${this.requests.length}` } : {}),
          ...(reply.headers ?? {}),
        })
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.#server = server
    this.#url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = null
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  #reply(
    provider: ProviderName,
    stage: Stage,
    context: Record<string, unknown> | null,
    scripted: Scripted | undefined,
  ): { status: number; body: unknown; headers?: Record<string, string> } {
    const error = (status: number, type: string, message: string, code?: string) =>
      provider === 'openai'
        ? { status, body: { error: { message, type, code: code ?? null } } }
        : { status, body: { type: 'error', error: { type, message } } }
    switch (scripted) {
      case 'unauthorized':
        return error(401, 'authentication_error', 'invalid x-api-key', 'invalid_api_key')
      case 'rate_limited':
        return {
          ...error(429, 'rate_limit_error', 'slow down', 'rate_limit_exceeded'),
          headers: { 'retry-after': '7' },
        }
      case 'server_error':
        return error(529, 'overloaded_error', 'overloaded')
      case 'policy_error':
        return error(
          400,
          'invalid_request_error',
          'Your request was flagged as potentially violating our usage policy.',
          'invalid_prompt',
        )
      case 'refuse':
        return provider === 'openai'
          ? this.#openai([{ type: 'refusal', refusal: 'I can’t help with that.' }])
          : this.#anthropic('', 'refusal')
      case 'text_refusal':
        return this.#text(provider, 'I’m sorry, but I can’t help with describing these images.')
      case 'broken':
        return this.#text(provider, JSON.stringify({ unexpected: true }))
      default: {
        const answer =
          scripted && typeof scripted === 'object' ? scripted.answer : defaultAnswer(stage, context)
        return this.#text(provider, JSON.stringify(answer))
      }
    }
  }

  #text(provider: ProviderName, text: string) {
    return provider === 'openai'
      ? this.#openai([{ type: 'output_text', text, annotations: [] }])
      : this.#anthropic(text, 'end_turn')
  }

  #openai(content: Record<string, unknown>[]) {
    return {
      status: 200,
      body: {
        id: `resp_${this.requests.length}`,
        object: 'response',
        status: 'completed',
        model: 'fake-model',
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content },
        ],
        usage: { ...USAGE, total_tokens: USAGE.input_tokens + USAGE.output_tokens },
      },
    }
  }

  #anthropic(text: string, stop: 'end_turn' | 'refusal') {
    return {
      status: 200,
      body: {
        id: `msg_${this.requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'fake-model',
        content: text ? [{ type: 'text', text }] : [],
        stop_reason: stop,
        stop_sequence: null,
        stop_details:
          stop === 'refusal'
            ? { type: 'refusal', category: 'general_harms', explanation: 'declined by policy' }
            : null,
        usage: { ...USAGE, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  }
}
