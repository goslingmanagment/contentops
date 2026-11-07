import { contextFor, frameLabel, instructionsFor, OUTPUT_SCHEMA } from './prompts.ts'
import type { ProviderName, Usage, VisionInput } from './types.ts'

/**
 * Money of a request (SPEC §8.3 «резерв стоимости до отправки»). The reserve is an upper bound
 * of what one request may cost — every input token counted generously and the whole output
 * allowance — so the spending limit holds before the answer comes; the cost is what the
 * provider reports in `usage`.
 */

/** US dollars per million tokens. */
export interface Price {
  input: number
  output: number
}

/**
 * Prices known in code; everything else — the price a provider's consent names (`prices`),
 * without one the request is not sent. Claude: Anthropic's API rates of 06.10.2026 (Haiku 5.5:
 * prompts up to 100K tokens, more than any stage sends).
 */
export const KNOWN_PRICES: Record<ProviderName, Readonly<Record<string, Price>>> = {
  anthropic: {
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  },
  openai: {},
}

/**
 * Tokens of one 512 px picture, rounded up: Anthropic counts width × height / 750 (≤ 350 here),
 * OpenAI up to 765 for a picture of four tiles; the patch counting of newer models stays below.
 */
const IMAGE_TOKENS: Record<ProviderName, number> = { anthropic: 400, openai: 800 }

/** Text tokens: one per two characters covers Russian, JSON and the schema. */
const textTokens = (text: string) => Math.ceil(text.length / 2)

/** The most input tokens the request can take. */
export function inputTokenBound(provider: ProviderName, input: VisionInput): number {
  let tokens =
    textTokens(instructionsFor(input.stage)) +
    textTokens(contextFor(input)) +
    textTokens(JSON.stringify(OUTPUT_SCHEMA[input.stage])) +
    200
  if (input.stage === 'observe') {
    for (const frame of input.frames) {
      tokens += IMAGE_TOKENS[provider] + textTokens(frameLabel(frame.n, frame.t_s))
    }
  }
  return tokens
}

/** Dollars, rounded up to the micro-dollar the database keeps. */
export function usdOf(tokens: Usage, price: Price): number {
  const exact = (tokens.input_tokens * price.input + tokens.output_tokens * price.output) / 1e6
  return Math.ceil(exact * 1e6) / 1e6
}

export function reserveOf(
  provider: ProviderName,
  input: VisionInput,
  maxOutputTokens: number,
  price: Price,
): number {
  return usdOf(
    { input_tokens: inputTokenBound(provider, input), output_tokens: maxOutputTokens },
    price,
  )
}
