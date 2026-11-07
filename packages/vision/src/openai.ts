import { createHash } from 'node:crypto'
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
  Usage,
  VisionInput,
  VisionProvider,
  VisionResult,
} from './types.ts'

/**
 * OpenAI through the Responses API (`POST /v1/responses`) over plain HTTP. `store: false`: the
 * answer is not kept by OpenAI for later reads (the storage setting of the measurement, PLAN 8а).
 * Pictures go as data URLs with `detail: low` — 512 px is what that detail sees anyway.
 */

export interface OpenAiOptions {
  apiKey: string
  /** `https://api.openai.com/v1` unless a test points it at its fake server. */
  baseUrl?: string
  fetch?: typeof fetch
}

/** Error codes of a request the policy turned down: a refusal, not a broken request. */
const POLICY_CODES = new Set([
  'content_policy_violation',
  'invalid_prompt',
  'content_filter',
  'moderation_blocked',
  'safety_violation',
])

interface ErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown }
}

function errorParts(text: string): { message: string; code: string | null } {
  try {
    const body = JSON.parse(text) as ErrorBody
    return {
      message: typeof body.error?.message === 'string' ? body.error.message : text.slice(0, 300),
      code: typeof body.error?.code === 'string' ? body.error.code : null,
    }
  } catch {
    return { message: text.slice(0, 300), code: null }
  }
}

function bodyOf(input: VisionInput, call: CallOptions): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: contextFor(input) }]
  if (input.stage === 'observe') {
    for (const frame of input.frames) {
      content.push({ type: 'input_text', text: frameLabel(frame.n, frame.t_s) })
      content.push({
        type: 'input_image',
        image_url: `data:${frame.mime};base64,${frame.data.toString('base64')}`,
        detail: 'low',
      })
    }
  }
  return {
    model: call.model,
    instructions: instructionsFor(input.stage),
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: input.stage,
        schema: OUTPUT_SCHEMA[input.stage],
        strict: true,
      },
    },
    max_output_tokens: call.maxOutputTokens,
    store: false,
    ...(call.effort ? { reasoning: { effort: call.effort } } : {}),
  }
}

interface ResponseBody {
  status?: unknown
  model?: unknown
  incomplete_details?: { reason?: unknown } | null
  output?: { type?: unknown; content?: { type?: unknown; text?: unknown; refusal?: unknown }[] }[]
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

function usageOf(body: ResponseBody): Usage | null {
  const input = body.usage?.input_tokens
  const output = body.usage?.output_tokens
  return typeof input === 'number' && typeof output === 'number'
    ? { input_tokens: input, output_tokens: output }
    : null
}

export function createOpenAiProvider(options: OpenAiOptions): VisionProvider {
  const base = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const fetchImpl = options.fetch ?? fetch

  async function run<S extends Stage>(
    input: VisionInput & { stage: S },
    call: CallOptions,
  ): Promise<VisionResult<StageOutput[S]>> {
    const body = JSON.stringify(bodyOf(input, call))
    const signal = call.signal
      ? AbortSignal.any([call.signal, AbortSignal.timeout(call.timeoutMs)])
      : AbortSignal.timeout(call.timeoutMs)
    let response: Response
    try {
      call.onSent({
        sha256: createHash('sha256').update(body).digest(),
        bytes: Buffer.byteLength(body),
      })
      response = await fetchImpl(`${base}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal,
      })
    } catch (cause) {
      if (neverConnected(cause)) {
        throw new VisionError('transient', 'openai: no connection', { cause })
      }
      throw new VisionError('unknown_outcome', 'openai: no answer to a sent request', { cause })
    }
    const requestId = response.headers.get('x-request-id')
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      throw new VisionError('unknown_outcome', 'openai: the answer was cut', {
        status: response.status,
        requestId,
        cause,
      })
    }
    if (!response.ok) {
      const { message, code } = errorParts(text)
      const init = { status: response.status, requestId }
      if (response.status === 400 && (POLICY_CODES.has(code ?? '') || soundsLikeRefusal(message))) {
        return {
          kind: 'refused',
          reason: message,
          usage: null,
          requestId,
          envelope: { status: 400, stop: code ?? 'policy', model: null },
        }
      }
      if (
        response.status === 401 ||
        response.status === 402 ||
        response.status === 403 ||
        code === 'insufficient_quota'
      ) {
        throw new VisionError('auth_rejected', `openai: HTTP ${response.status} ${message}`, init)
      }
      if (response.status === 429) {
        throw new VisionError('rate_limited', `openai: HTTP 429 ${message}`, {
          ...init,
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        })
      }
      if (response.status >= 500) {
        throw new VisionError('transient', `openai: HTTP ${response.status}`, init)
      }
      throw new VisionError('bad_request', `openai: HTTP ${response.status} ${message}`, init)
    }
    let parsed: ResponseBody
    try {
      parsed = JSON.parse(text) as ResponseBody
    } catch (cause) {
      throw new VisionError('bad_response', 'openai: the envelope is not JSON', {
        status: response.status,
        requestId,
        cause,
      })
    }
    const usage = usageOf(parsed)
    const reason =
      typeof parsed.incomplete_details?.reason === 'string'
        ? parsed.incomplete_details.reason
        : null
    const envelope: Envelope = {
      status: response.status,
      stop: typeof parsed.status === 'string' ? (reason ?? parsed.status) : reason,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    }
    const parts = (parsed.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
    const refusal = parts.find((part) => part.type === 'refusal')
    if (refusal || reason === 'content_filter') {
      return {
        kind: 'refused',
        reason:
          typeof refusal?.refusal === 'string' && refusal.refusal.trim()
            ? refusal.refusal.trim()
            : 'content_filter',
        usage,
        requestId,
        envelope,
      }
    }
    if (reason === 'max_output_tokens') {
      throw new VisionError('bad_response', 'openai: the answer hit max_output_tokens', {
        status: response.status,
        requestId,
        usage,
      })
    }
    const answer = parts
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
    const result = parseAnswer(input.stage, answer, { requestId, usage })
    return result.kind === 'refused'
      ? { kind: 'refused', reason: result.reason, usage, requestId, envelope }
      : { kind: 'answer', output: result.output, usage, requestId, envelope }
  }

  const provider: VisionProvider = {
    name: 'openai',
    observe: (input: ObserveInput, call: CallOptions) => run(input, call),
    compose: ((input: ComposeInput, call: CallOptions) =>
      run(input, call)) as VisionProvider['compose'],
  }
  return provider
}
