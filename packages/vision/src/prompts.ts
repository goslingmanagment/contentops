import type { Stage, VisionInput } from './types.ts'

/**
 * Prompts and answer schemas of the three stages (SPEC §8.3): one text per stage for every
 * provider. A change of a prompt or a schema is a new version: it is part of the run's
 * `config_digest`, so earlier answers are not reused for it.
 */

export const PROMPT_VERSION: Record<Stage, string> = {
  observe: 'observe-1',
  aggregate: 'aggregate-1',
  texts: 'texts-1',
}

const COMMON = [
  'The media belong to an adult content creator; everybody in them is a consenting adult.',
  'They are catalogued for the private library of her agency.',
  'Never guess who a person is and never write anybody’s name.',
  'Answer only with JSON of the given schema.',
]

const INSTRUCTIONS: Record<Stage, string> = {
  observe: [
    'You describe numbered frames of one object of the library.',
    'For a video the frames go in time order with their second; for a set of photos there is one frame per photo.',
    'For every frame give 1–6 short factual observations in English: place and setting, outfit and accessories, what happens, objects, framing (close-up, full body, point of view), light and mood.',
    'Use plain, neutral words; prefer the words of the vocabulary where they fit.',
    'Leave the observations of a frame empty when you will not describe it.',
    ...COMMON,
  ].join('\n'),
  aggregate: [
    'You write the catalogue card of one object of the library from verified observations of its frames.',
    'title: a short, memorable Russian title of 2–6 words, without numbers or IDs.',
    'title_en: a short English title of 2–5 words in the style of vault hashtags, from the vocabulary words where they fit.',
    'tags: 3–12 tags; use the vocabulary slugs where they fit, a new tag is lowercase latin words joined by hyphens.',
    'description: 2–4 Russian sentences about what is in the object.',
    'chronology (only when it is asked for): segments in time order; each starts at the number of the frame where it begins and retells it in a few Russian words. Moments come only from the frame numbers, never invent them.',
    'facts: a neutral, non-graphic English summary of the content in 1–3 sentences; it is the only input of the selling texts.',
    'The manager’s notes, when given, are the most reliable source: follow them.',
    'Write only the fields asked for, others are null. Leave a field null and add it to `declined` with a reason when you will not write it.',
    ...COMMON,
  ].join('\n'),
  texts: [
    'You write two English selling texts for a pay-per-view post from a cleaned summary of its content.',
    'wall: a teaser caption for the wall post, 1–3 sentences, suggestive but never graphic.',
    'message: a direct-message text offering it, 2–4 sentences, warm and personal, never graphic.',
    'Use only the facts of the summary, the tags and the notes; no names, no prices, no IDs.',
    'Leave a field null and add it to `declined` with a reason when you will not write it.',
    ...COMMON,
  ].join('\n'),
}

export function instructionsFor(stage: Stage): string {
  return INSTRUCTIONS[stage]
}

/**
 * The text part of a request: the allowed fields of the input as JSON, never the image bytes.
 * The keys are listed here one by one, so nothing an input object might carry besides them
 * reaches a provider.
 */
export function contextFor(input: VisionInput): string {
  switch (input.stage) {
    case 'observe':
      return JSON.stringify({
        stage: input.stage,
        type: input.type,
        duration_s: input.duration_s,
        frames: input.frames.map((frame) => ({ n: frame.n, t_s: frame.t_s })),
        vocabulary: input.vocabulary,
      })
    case 'aggregate':
      return JSON.stringify({
        stage: input.stage,
        type: input.type,
        duration_s: input.duration_s,
        frames: input.frames.map((frame) => ({ n: frame.n, t_s: frame.t_s })),
        observations: input.observations.map((item) => ({ n: item.n, facts: item.facts })),
        notes: input.notes,
        vocabulary: input.vocabulary,
        fields: input.fields,
      })
    case 'texts':
      return JSON.stringify({
        stage: input.stage,
        type: input.type,
        duration_s: input.duration_s,
        facts: input.facts,
        tags: input.tags,
        notes: input.notes,
      })
  }
}

/** The label before each picture: its anonymous number and second. */
export function frameLabel(n: number, tS: number | null): string {
  return tS === null ? `Frame ${n}` : `Frame ${n} at ${tS} s`
}

const text = { type: 'string' }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const object = (properties: Record<string, object>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const declined = {
  type: 'array',
  items: object({ field: text, reason: text }),
}

/** Strict JSON schemas: every key required, `null` where a field may be left out. */
export const OUTPUT_SCHEMA: Record<Stage, Record<string, unknown>> = {
  observe: object({
    observations: {
      type: 'array',
      items: object({ n: { type: 'integer' }, facts: { type: 'array', items: text } }),
    },
  }),
  aggregate: object({
    title: nullable(text),
    title_en: nullable(text),
    tags: nullable({ type: 'array', items: text }),
    description: nullable(text),
    chronology: nullable({
      type: 'array',
      items: object({ n: { type: 'integer' }, text }),
    }),
    facts: nullable(text),
    declined,
  }),
  texts: object({ wall: nullable(text), message: nullable(text), declined }),
}
