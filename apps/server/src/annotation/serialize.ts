import type {
  AggregateField,
  AggregateInput,
  Observation,
  ObserveInput,
  OutFrame,
  TextsInput,
} from '@contentops/vision'
import type { AnnotationSubject, Privacy } from './subject'

/**
 * The composition of what goes out (SPEC §8.3): only frames of 512 px without metadata,
 * anonymous frame numbers and moments, the duration, the type, the tag dictionary, verified
 * observations, the cleaned summary of facts and the manager's notes. Never the video or the
 * sound, paths and file names, order cards and texts, account IDs, the model's name, secrets.
 * Each input below is built field by field from the subject; nothing else of it is read.
 */

/** The notes of 2–5 lines, at most. */
const NOTES_LIMIT = 600

const FILE_NAME =
  /[^\s/\\]+\.(mp4|mov|m4v|mkv|avi|webm|hevc|heic|heif|jpe?g|png|webp|gif|tiff?|dng|raw|zip|rar|7z)\b/gi
const PATH = /(?:[a-z]:)?(?:[\\/][^\s\\/]+){2,}[\\/]?/gi
const LINK = /\b(?:https?:\/\/|www\.|t\.me\/)\S+/gi
const HANDLE = /(^|\s)@[\w.]+/g

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A fragment of an order's text long enough to recognise it inside the notes. */
const ORDER_FRAGMENT = 16

const squeeze = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Drops from the notes every sentence that repeats an order's text (SPEC §8.3 «никогда — карточки
 * и тексты заказов»): an agent or a manager may have copied the brief into the description.
 */
function withoutOrderTexts(text: string, orders: readonly string[]): string {
  const fragments = orders
    .flatMap((order) => order.split(/[.!?\n;]+/))
    .map(squeeze)
    .filter((fragment) => fragment.length >= ORDER_FRAGMENT)
  if (fragments.length === 0) return text
  return text
    .split(/(?<=[.!?\n;])/)
    .filter((sentence) => {
      const plain = squeeze(sentence)
      return !fragments.some(
        (fragment) =>
          plain.includes(fragment) || (plain.length >= ORDER_FRAGMENT && fragment.includes(plain)),
      )
    })
    .join('')
}

/**
 * Free text of a person as it may go out: an order's sentences dropped, links, paths, file names
 * and @handles out, the model's names and her pages' codes and handles replaced, the length held
 * to a few lines. Fan names stay (owner's decision of 30.10.2026: no filter of them).
 */
export function cleanText(text: string | null, privacy: Partial<Privacy>): string | null {
  if (!text) return null
  let out = withoutOrderTexts(text.normalize('NFC'), privacy.orders ?? [])
  out = out.replace(LINK, '[ссылка]').replace(PATH, '[путь]')
  out = out.replace(FILE_NAME, '[файл]').replace(HANDLE, '$1[ник]')
  const names = [...new Set((privacy.names ?? []).map((name) => name.normalize('NFC')))].sort(
    (a, b) => b.length - a.length,
  )
  for (const name of names) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, 'giu'),
      'модель',
    )
  }
  out = out.replace(/[ \t]+/g, ' ').trim()
  if (!out) return null
  return out.length > NOTES_LIMIT ? `${out.slice(0, NOTES_LIMIT - 1)}…` : out
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 1000))

/** The frames as they go out: number 1…n in the order of the subject, their seconds, pictures. */
export function observeInput(
  subject: AnnotationSubject,
  frames: readonly { frameMs: number | null; data: Buffer }[],
): ObserveInput {
  return {
    stage: 'observe',
    type: subject.type,
    duration_s: seconds(subject.durationMs),
    frames: frames.map(
      (frame, index): OutFrame => ({
        n: index + 1,
        t_s: seconds(frame.frameMs),
        mime: 'image/webp',
        data: frame.data,
      }),
    ),
    vocabulary: [...subject.vocabulary],
  }
}

const FACT_LIMIT = 200
const FACTS_PER_FRAME = 8

/**
 * The observations a stage may pass on: only of the frames that were sent, a few short facts
 * each; free text is cleaned like a person's (a model does not know the names, a check costs
 * nothing).
 */
export function verifiedObservations(
  observations: readonly Observation[],
  frameCount: number,
  privacy: Partial<Privacy>,
): Observation[] {
  const byFrame = new Map<number, string[]>()
  for (const item of observations) {
    if (!Number.isInteger(item.n) || item.n < 1 || item.n > frameCount) continue
    const facts = item.facts
      .map((fact) => cleanText(fact, privacy))
      .filter((fact): fact is string => Boolean(fact))
      .map((fact) => fact.slice(0, FACT_LIMIT))
    if (facts.length > 0) {
      byFrame.set(item.n, [...(byFrame.get(item.n) ?? []), ...facts].slice(0, FACTS_PER_FRAME))
    }
  }
  return [...byFrame.entries()].sort(([a], [b]) => a - b).map(([n, facts]) => ({ n, facts }))
}

export function aggregateInput(
  subject: AnnotationSubject,
  sent: { frames: readonly { n: number; t_s: number | null }[]; observations: Observation[] },
  fields: readonly AggregateField[],
): AggregateInput {
  return {
    stage: 'aggregate',
    type: subject.type,
    duration_s: seconds(subject.durationMs),
    frames: sent.frames.map((frame) => ({ n: frame.n, t_s: frame.t_s })),
    observations: sent.observations.map((item) => ({ n: item.n, facts: [...item.facts] })),
    notes: cleanText(subject.notes, subject.privacy),
    vocabulary: [...subject.vocabulary],
    fields: subject.hasVideo ? [...fields] : fields.filter((field) => field !== 'chronology'),
  }
}

export function textsInput(
  subject: AnnotationSubject,
  facts: string,
  tags: readonly string[],
): TextsInput {
  const dictionary = new Set(subject.vocabulary)
  return {
    stage: 'texts',
    type: subject.type,
    duration_s: seconds(subject.durationMs),
    facts: cleanText(facts, subject.privacy) ?? '',
    tags: tags.filter((tag) => dictionary.has(tag)),
    notes: cleanText(subject.notes, subject.privacy),
  }
}
