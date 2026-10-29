import { instantMs } from '../clock'
import type { Instant, LocalDate } from '../domain/common'
import type { Evidence, PlacementFacts, PlacementLevel } from '../domain/placement'
import { capitalize, formatClock, formatDate, plural } from '../format'
import { allOf, latest } from './evidence'
import { dateOf, type Outcome } from './outcome'
import { SURFACE_LOCATIVE } from './surfaces'
import { factsToday, mismatchLabel, signedMinutes } from './texts'

/** ◆ «сверить» (DESIGN §5.2): what Hub saw that a person has to look at. */

function turn(level: PlacementLevel, detail: string, reason: string, at: Instant | null): Outcome {
  return { level, word: 'сверить', detail, reason, date: at ? dateOf(at) : null }
}

function candidatesOutcome(evidence: readonly Evidence[]): Outcome | null {
  const candidates = allOf(evidence, 'hub_candidate').sort(
    (left, right) => instantMs(left.post_at) - instantMs(right.post_at),
  )
  const first = candidates[0]
  if (!first) return null
  if (candidates.length > 1) {
    const times = candidates.map((candidate) => formatClock(candidate.post_at)).join(' и ')
    const variants = plural(candidates.length, ['вариант', 'варианта', 'вариантов'])
    return turn(
      'candidates_multiple',
      `${candidates.length} ${variants}`,
      `Посты ${times}`,
      first.post_at,
    )
  }
  return turn(
    'candidate',
    'Hub нашёл похожее',
    `Пост ${formatClock(first.post_at)}, ${signedMinutes(first.offset_min)} · ${first.summary}`,
    first.post_at,
  )
}

function postQuestion(facts: PlacementFacts, evidence: readonly Evidence[]): Outcome | null {
  const conflict = latest(evidence, 'hub_conflict')
  if (conflict) {
    const marked = formatClock(facts.plan?.mark?.at ?? conflict.post_at)
    return turn(
      'conflict',
      'отметка и Hub расходятся',
      `Отмечено ${marked}, а Hub видит в это время ${conflict.other}`,
      conflict.post_at,
    )
  }
  const mismatch = latest(evidence, 'hub_mismatch')
  if (mismatch) {
    const label = mismatchLabel(mismatch.field)
    return turn(
      'mismatch',
      `${label} ${mismatch.ours} и ${mismatch.theirs}`,
      `${capitalize(label)} ${mismatch.ours} и ${mismatch.theirs} — не совпадает`,
      mismatch.post_at,
    )
  }
  const partial = latest(evidence, 'hub_partial')
  if (partial) {
    return turn(
      'partial_match',
      `совпало ${partial.matched} из ${partial.total}`,
      capitalize(partial.missing),
      null,
    )
  }
  return candidatesOutcome(evidence)
}

function unboundQuestion(facts: PlacementFacts, evidence: readonly Evidence[]): Outcome | null {
  // With a marked row the surface comes from the row (SPEC §7): no «стена или фуп?».
  const surface = facts.plan?.mark ? null : latest(evidence, 'hub_surface_unknown')
  if (surface) {
    return turn(
      'surface_unknown',
      'стена или фуп?',
      `Файл совпал точно, пост ${formatClock(surface.post_at)}`,
      surface.post_at,
    )
  }
  const unplanned = latest(evidence, 'hub_unplanned')
  if (unplanned) {
    const where = SURFACE_LOCATIVE[unplanned.surface_seen]
    return turn(
      'unplanned_post',
      'пост без плана',
      `Hub видел ${where} ${formatClock(unplanned.post_at)} · ${unplanned.summary}`,
      unplanned.post_at,
    )
  }
  return null
}

function vaultQuestion(evidence: readonly Evidence[], today: LocalDate): Outcome | null {
  const stale = latest(evidence, 'vault_stale')
  if (stale) {
    return turn(
      'vault_stale',
      'старый файл в альбоме',
      `В альбоме файл от ${formatDate(stale.file_on, today)}, строка от ${formatDate(stale.row_on, today)}`,
      null,
    )
  }
  const missing = latest(evidence, 'vault_missing')
  if (missing) {
    return turn(
      'vault_missing',
      'в альбоме нет файла',
      `Альбом «${missing.album}» обойдён ${formatDate(missing.walked_on, today)}, файла нет`,
      null,
    )
  }
  return null
}

/** The open question with the highest priority, or `null` when Hub asks nothing. */
export function question(facts: PlacementFacts, evidence: readonly Evidence[]): Outcome | null {
  return (
    postQuestion(facts, evidence) ??
    unboundQuestion(facts, evidence) ??
    vaultQuestion(evidence, factsToday(facts))
  )
}
