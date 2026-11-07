/**
 * The boundary of the cloud markup (SPEC §12.0 `VisionProvider`, §8.3): two operations —
 * observations by frames, and text by verified facts. The inputs below are everything that may
 * leave ContentOps: frames of 512 px without metadata, anonymous frame numbers and moments, the
 * duration, the type, the tag dictionary, verified observations, the cleaned summary of facts
 * and the manager's notes. The serializer of the server builds them from allowed fields only;
 * an adapter turns them into one HTTP request and adds nothing of the object.
 */

/** Providers with an adapter (`values.annotationProviders` of `@contentops/db`). */
export type ProviderName = 'openai' | 'anthropic'

export type Stage = 'observe' | 'aggregate' | 'texts'

/** Object types that are marked up; a `PRM` collection has no content of its own. */
export type MarkupType = 'PPV' | 'SET' | 'SXT' | 'CUS' | 'FYP' | 'LIFE' | 'RAW'

/** A frame as it goes out: its number in the request, its second in the video, the picture. */
export interface OutFrame {
  n: number
  /** Whole seconds from the start of the video; `null` for a photo. */
  t_s: number | null
  mime: 'image/webp'
  data: Buffer
}

export interface ObserveInput {
  stage: 'observe'
  type: MarkupType
  duration_s: number | null
  frames: OutFrame[]
  /** Slugs of the shared tag dictionary: the words to name what is seen. */
  vocabulary: string[]
}

export interface Observation {
  n: number
  facts: string[]
}

/** Fields the `aggregate` stage writes; a route may ask for some of them only. */
export const AGGREGATE_FIELDS = ['title', 'title_en', 'tags', 'description', 'chronology'] as const
export type AggregateField = (typeof AGGREGATE_FIELDS)[number]

export interface AggregateInput {
  stage: 'aggregate'
  type: MarkupType
  duration_s: number | null
  /** Numbers and moments of the frames observed: a chronology segment starts at one of them. */
  frames: { n: number; t_s: number | null }[]
  observations: Observation[]
  /** The manager's notes (the confirmed description), cleaned; `null` when there are none. */
  notes: string | null
  vocabulary: string[]
  fields: AggregateField[]
}

export interface TextsInput {
  stage: 'texts'
  type: MarkupType
  duration_s: number | null
  /** The cleaned, non-graphic summary the `aggregate` stage wrote. */
  facts: string
  /** Tags of the object that are words of the shared dictionary. */
  tags: string[]
  notes: string | null
}

export type ComposeInput = AggregateInput | TextsInput
export type VisionInput = ObserveInput | ComposeInput

export interface Declined {
  field: string
  reason: string
}

export interface ObserveOutput {
  observations: Observation[]
}

export interface AggregateOutput {
  title: string | null
  title_en: string | null
  tags: string[] | null
  description: string | null
  /** Segments by the number of the frame each one starts at: the minutes come from the frames. */
  chronology: { n: number; text: string }[] | null
  facts: string | null
  declined: Declined[]
}

export interface TextsOutput {
  wall: string | null
  message: string | null
  declined: Declined[]
}

export interface StageOutput {
  observe: ObserveOutput
  aggregate: AggregateOutput
  texts: TextsOutput
}

export interface Usage {
  input_tokens: number
  output_tokens: number
}

/** What was handed to the network, without the content: the receipt's hash and size. */
export interface Sent {
  sha256: Buffer
  bytes: number
}

/** A cleaned diagnostic envelope of the answer (schema §9.8 `raw_response`): never an echo. */
export interface Envelope {
  status: number
  stop: string | null
  model: string | null
  /** The provider's category of a refusal, when it names one. */
  category?: string | null
}

/** The provider answered: with the output, or with a refusal (a normal outcome, SPEC §8.3). */
export type VisionResult<T> =
  | {
      kind: 'answer'
      output: T
      usage: Usage | null
      requestId: string | null
      envelope: Envelope
    }
  | {
      kind: 'refused'
      reason: string
      usage: Usage | null
      requestId: string | null
      envelope: Envelope
    }

export interface CallOptions {
  model: string
  /** The provider's effort or reasoning level; omitted when `null`. */
  effort?: string | null
  maxOutputTokens: number
  timeoutMs: number
  signal?: AbortSignal
  /** Called when the body is handed to the network: from here on the outcome may be unknown. */
  onSent: (sent: Sent) => void
}

export interface VisionProvider {
  readonly name: ProviderName
  /** Observations by frames. */
  observe(input: ObserveInput, call: CallOptions): Promise<VisionResult<ObserveOutput>>
  /** Text by verified facts: the fields of the card, or the selling texts. */
  compose(input: AggregateInput, call: CallOptions): Promise<VisionResult<AggregateOutput>>
  compose(input: TextsInput, call: CallOptions): Promise<VisionResult<TextsOutput>>
}
