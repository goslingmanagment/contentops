import { z } from 'zod'
import { soundsLikeRefusal, VisionError } from './errors.ts'
import type { Stage, StageOutput, Usage } from './types.ts'

/**
 * The answer of a stage as the schema wants it. A text instead of JSON that sounds like a
 * refusal is a refusal (SPEC §8.3 «отказ текстом в успешном ответе»); anything else that does
 * not parse is a broken answer.
 */

const trimmed = z.string().transform((value) => value.trim())
const declined = z.array(z.object({ field: z.string(), reason: z.string() })).default([])

const OUTPUT = {
  observe: z.object({
    observations: z.array(z.object({ n: z.number().int(), facts: z.array(trimmed) })),
  }),
  aggregate: z.object({
    title: trimmed.nullable(),
    title_en: trimmed.nullable(),
    tags: z.array(trimmed).nullable(),
    description: trimmed.nullable(),
    chronology: z.array(z.object({ n: z.number().int(), text: trimmed })).nullable(),
    facts: trimmed.nullable(),
    declined,
  }),
  texts: z.object({ wall: trimmed.nullable(), message: trimmed.nullable(), declined }),
} as const

export type Parsed<S extends Stage> =
  | { kind: 'answer'; output: StageOutput[S] }
  | { kind: 'refused'; reason: string }

/** The text the model wrote (thinking left out) → the stage's output or a refusal in words. */
export function parseAnswer<S extends Stage>(
  stage: S,
  text: string,
  meta: { requestId: string | null; usage: Usage | null },
): Parsed<S> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (cause) {
    if (soundsLikeRefusal(text)) return { kind: 'refused', reason: text.trim().slice(0, 300) }
    throw new VisionError('bad_response', `${stage}: the answer is not JSON`, { ...meta, cause })
  }
  const parsed = OUTPUT[stage].safeParse(json)
  if (!parsed.success) {
    throw new VisionError(
      'bad_response',
      `${stage}: the answer breaks the schema (${parsed.error.issues[0]?.message ?? 'unknown'})`,
      meta,
    )
  }
  return { kind: 'answer', output: parsed.data as StageOutput[S] }
}
