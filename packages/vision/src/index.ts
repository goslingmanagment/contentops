/**
 * The cloud markup's boundary (SPEC §8.3, §12.0 `VisionProvider`): the adapters of the
 * providers, the prompts and answer schemas of the stages, the prices and the reserve of a
 * request. A pure client: no database, no settings, no keys of its own.
 */
export { type AnthropicOptions, createAnthropicProvider } from './anthropic.ts'
export { KNOWN_PRICES, type Price, reserveOf, usdOf } from './cost.ts'
export { VisionError, type VisionErrorKind } from './errors.ts'
export { createOpenAiProvider, type OpenAiOptions } from './openai.ts'
export { OUTPUT_SCHEMA, PROMPT_VERSION } from './prompts.ts'
export {
  AGGREGATE_FIELDS,
  type AggregateField,
  type AggregateInput,
  type AggregateOutput,
  type CallOptions,
  type ComposeInput,
  type Declined,
  type Envelope,
  type MarkupType,
  type Observation,
  type ObserveInput,
  type ObserveOutput,
  type OutFrame,
  type ProviderName,
  type Sent,
  type Stage,
  type StageOutput,
  type TextsInput,
  type TextsOutput,
  type Usage,
  type VisionInput,
  type VisionProvider,
  type VisionResult,
} from './types.ts'
