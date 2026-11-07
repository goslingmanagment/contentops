import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { neverConnected, retryAfterMs, soundsLikeRefusal, VisionError } from './errors.ts'
import { parseAnswer } from './output.ts'
import { contextFor, frameLabel, instructionsFor, OUTPUT_SCHEMA } from './prompts.ts'
import type {
  CallOptions,
  ComposeInput,
  Envelope,
  ObserveInput,
  Stage,
  StageOutput,
  VisionInput,
  VisionProvider,
  VisionResult,
} from './types.ts'

/**
 * Claude through the Messages API with the official SDK. The SDK does not retry (`maxRetries:
 * 0`): a repeat is the runner's decision, never after a refusal or an unknown outcome. The
 * server-side `fallbacks` to another Claude model stay off on purpose: SPEC §8.3 allows no repeat
 * to the same provider with the same input, the one spare is an independent provider.
 * Structured output by `output_config.format`; a policy decline comes as `stop_reason: refusal`.
 */

export interface AnthropicOptions {
  apiKey: string
  /** The SDK's default address unless a test points it at its fake server. */
  baseUrl?: string
  fetch?: typeof fetch
}

type Content = Anthropic.Messages.ContentBlockParam

function contentOf(input: VisionInput): Content[] {
  const content: Content[] = [{ type: 'text', text: contextFor(input) }]
  if (input.stage === 'observe') {
    for (const frame of input.frames) {
      content.push({ type: 'text', text: frameLabel(frame.n, frame.t_s) })
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: frame.mime, data: frame.data.toString('base64') },
      })
    }
  }
  return content
}

/** The request body as the SDK sends it: its hash and size go to the receipt. */
function sentOf(init: RequestInit | undefined): { sha256: Buffer; bytes: number } {
  const body = typeof init?.body === 'string' ? init.body : ''
  return { sha256: createHash('sha256').update(body).digest(), bytes: Buffer.byteLength(body) }
}

export function createAnthropicProvider(options: AnthropicOptions): VisionProvider {
  const baseFetch = options.fetch ?? fetch

  async function run<S extends Stage>(
    input: VisionInput & { stage: S },
    call: CallOptions,
  ): Promise<VisionResult<StageOutput[S]>> {
    let sent = false
    const client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      maxRetries: 0,
      timeout: call.timeoutMs,
      fetch: (url, init) => {
        sent = true
        call.onSent(sentOf(init))
        return baseFetch(url, init)
      },
    })
    let message: Anthropic.Messages.Message
    let requestId: string | null
    try {
      const response = await client.messages
        .create(
          {
            model: call.model,
            max_tokens: call.maxOutputTokens,
            system: instructionsFor(input.stage),
            messages: [{ role: 'user', content: contentOf(input) }],
            output_config: {
              format: { type: 'json_schema', schema: OUTPUT_SCHEMA[input.stage] },
              ...(call.effort
                ? { effort: call.effort as NonNullable<Anthropic.Messages.OutputConfig['effort']> }
                : {}),
            },
          },
          call.signal ? { signal: call.signal } : {},
        )
        .withResponse()
      message = response.data
      requestId = response.request_id ?? null
    } catch (error) {
      const failure = classify(error, sent)
      if (isPolicyRefusal(failure)) {
        return {
          kind: 'refused',
          reason: failure.message,
          usage: null,
          requestId: failure.requestId,
          envelope: { status: 400, stop: 'policy', model: null },
        }
      }
      throw failure
    }
    const usage = {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    }
    const envelope: Envelope = {
      status: 200,
      stop: message.stop_reason,
      model: message.model,
      ...(message.stop_details ? { category: message.stop_details.category ?? null } : {}),
    }
    if (message.stop_reason === 'refusal') {
      const details = message.stop_details
      return {
        kind: 'refused',
        reason: details?.explanation ?? details?.category ?? 'refusal',
        usage,
        requestId,
        envelope,
      }
    }
    if (message.stop_reason === 'max_tokens') {
      throw new VisionError('bad_response', 'anthropic: the answer hit max_tokens', {
        status: 200,
        requestId,
        usage,
      })
    }
    const text = message.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const result = parseAnswer(input.stage, text, { requestId, usage })
    return result.kind === 'refused'
      ? { kind: 'refused', reason: result.reason, usage, requestId, envelope }
      : { kind: 'answer', output: result.output, usage, requestId, envelope }
  }

  const provider: VisionProvider = {
    name: 'anthropic',
    observe: (input: ObserveInput, call: CallOptions) => run(input, call),
    compose: ((input: ComposeInput, call: CallOptions) =>
      run(input, call)) as VisionProvider['compose'],
  }
  return provider
}

/** The SDK's errors, most specific first, as the failures of SPEC §8.3. */
function classify(error: unknown, sent: boolean): VisionError {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new VisionError('unknown_outcome', 'anthropic: no answer in time', { cause: error })
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return !sent || neverConnected(error)
      ? new VisionError('transient', 'anthropic: no connection', { cause: error })
      : new VisionError('unknown_outcome', 'anthropic: no answer to a sent request', {
          cause: error,
        })
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? null
    const init = { status, requestId: error.requestID ?? null, cause: error }
    if (status === 401 || status === 402 || status === 403) {
      return new VisionError('auth_rejected', `anthropic: HTTP ${status} ${error.message}`, init)
    }
    if (status === 429) {
      return new VisionError('rate_limited', 'anthropic: HTTP 429', {
        ...init,
        retryAfterMs: retryAfterMs(error.headers?.get('retry-after')),
      })
    }
    if (status !== null && status >= 500) {
      return new VisionError('transient', `anthropic: HTTP ${status}`, init)
    }
    return new VisionError('bad_request', `anthropic: HTTP ${status} ${error.message}`, init)
  }
  if (error instanceof VisionError) return error
  return sent
    ? new VisionError('unknown_outcome', 'anthropic: the request broke after it was sent', {
        cause: error,
      })
    : new VisionError('transient', 'anthropic: the request broke before it was sent', {
        cause: error,
      })
}

/** A 400 of the policy: a refusal, not a broken request (SPEC §8.3). */
function isPolicyRefusal(error: VisionError): boolean {
  return error.kind === 'bad_request' && error.status === 400 && soundsLikeRefusal(error.message)
}
