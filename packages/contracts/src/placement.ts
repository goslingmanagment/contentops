import type { Evidence, PlacementFacts, PlacementVerdict } from './domain/placement'
import { formatClock, formatDate, pastVerb } from './format'
import { confirmation } from './placement/confirmation'
import { allOf, latest, openEvidence, QUESTION_KINDS } from './placement/evidence'
import { signOfLevel } from './placement/levels'
import { dateOf, type Outcome } from './placement/outcome'
import { fromPlan } from './placement/plan-outcome'
import { question } from './placement/questions'
import { hubSilenceReason } from './placement/surfaces'
import {
  cancelledReason,
  describeEvidence,
  factsToday,
  threeFacts,
  unknownReason,
} from './placement/texts'

/**
 * The placement level and the word on screen are computed here and only here
 * (DESIGN §5.2, SPEC §7). The server answers the agent with the same function;
 * the browser never recomputes levels, it only filters and sorts.
 *
 * Order of the rules: a cancelled row; «не наше»; ✓ (it wins over ▲ «пропущено»);
 * ▲ second person on OnlyFans; ◆ what Hub asks; the plan row itself; «не видели».
 */

export { isInPlanLevel, isPlacedLevel, signOfLevel } from './placement/levels'
export { isAutoChecked, isCheckableSurface, markButtonKind } from './placement/surfaces'

function hubSentence(facts: PlacementFacts, evidence: readonly Evidence[]): string | null {
  const exact = latest(evidence, 'hub_exact')
  if (exact) {
    return exact.match === 'album'
      ? 'Hub видит файл в альбоме'
      : `Hub — пост ${formatClock(exact.post_at)}`
  }
  const partial = latest(evidence, 'hub_partial')
  if (partial)
    return `Hub видит в альбоме ${partial.matched} из ${partial.total}: ${partial.missing}`
  const open = evidence.find((item) => QUESTION_KINDS.has(item.kind))
  if (open) return describeEvidence(open, factsToday(facts))
  return facts.plan ? hubSilenceReason(facts) : null
}

function notesFor(facts: PlacementFacts, evidence: readonly Evidence[]): string[] {
  const notes = allOf(evidence, 'legacy_claim').map(
    (claim) => `в старом имени: ${claim.label} · ${formatDate(claim.on, factsToday(facts))}`,
  )
  const plan = facts.plan
  if (plan?.mark && !plan.mark.for_current_manifest) notes.push('Состав заменили после отметки')
  if (plan?.has_newer_version) notes.push('Есть новая версия — заменить состав?')
  return notes
}

function outcomeOf(facts: PlacementFacts, evidence: readonly Evidence[]): Outcome {
  const plan = facts.plan
  if (plan?.cancelled) {
    return {
      level: 'cancelled',
      word: 'отменена',
      detail: null,
      reason: cancelledReason(plan.cancelled),
      date: plan.slot_date,
    }
  }
  const outside = latest(evidence, 'outside_catalog')
  if (outside) {
    const who = `${pastVerb('Отметил', outside.by.gender)} ${outside.by.name}`
    return {
      level: 'outside_catalog',
      word: 'не наше',
      detail: null,
      reason: `${who}: не наш материал`,
      date: null,
    }
  }
  const confirmed = confirmation(facts, evidence)
  if (confirmed) return confirmed
  if (plan?.second_person_blocked && facts.account.platform === 'onlyfans') {
    return {
      level: 'blocked_second_person',
      word: 'нельзя на OnlyFans',
      detail: null,
      reason: 'Отметку «второй человек в кадре» поставили после постановки в план',
      date: plan.slot_date,
    }
  }
  const open = question(facts, evidence)
  if (open) return open
  if (plan) return fromPlan(facts, plan)
  const history = latest(evidence, 'hub_history')
  if (history) {
    return {
      level: 'history_candidate',
      word: 'похоже, выходило',
      detail: formatDate(dateOf(history.post_at), factsToday(facts)),
      reason: `Hub: похожий пост ${formatDate(dateOf(history.post_at), factsToday(facts))} по имени или длительности и размерам, не подтверждение`,
      date: dateOf(history.post_at),
    }
  }
  const walk = latest(evidence, 'walk_not_found')
  if (walk) {
    const reason = `Не найден при обходе от ${formatDate(walk.walked_from, factsToday(facts))}`
    return { level: 'not_found_in_walk', word: 'не проверено', detail: null, reason, date: null }
  }
  return {
    level: 'unknown',
    word: 'не видели',
    detail: null,
    reason: unknownReason(facts),
    date: null,
  }
}

/** Level, sign, word and «почему» of one placement from its facts. */
export function evaluatePlacement(facts: PlacementFacts): PlacementVerdict {
  const evidence = openEvidence(facts.evidence)
  const outcome = outcomeOf(facts, evidence)
  return {
    level: outcome.level,
    sign: signOfLevel(outcome.level),
    word: outcome.word,
    detail: outcome.detail,
    reason: outcome.reason,
    notes: notesFor(facts, evidence),
    date: outcome.date,
    facts: threeFacts(facts, hubSentence(facts, evidence)),
  }
}
