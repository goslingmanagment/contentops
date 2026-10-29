import { instantMs } from '../clock'
import type { Instant } from '../domain/common'
import type { PlacementFacts, PlanFacts } from '../domain/placement'
import { dateOf, hoursPassed, laterOf, type Outcome } from './outcome'
import { hubSilenceReason, isAutoChecked, isCheckableSurface } from './surfaces'
import {
  coverageReason,
  factsToday,
  markReason,
  missedReason,
  plannedReason,
  slotDeadline,
  slotInstant,
} from './texts'

/** Levels of a planned row without a Hub answer: in plan, missed, marked, scheduled, unverified. */

/** After the «ждём Hub» window: «не вышло» once E7 is on and Hub sees everything, else «не проверено». */
function afterWindow(facts: PlacementFacts, anchor: Instant): Outcome | null {
  const { hub, thresholds, now } = facts
  if (!hoursPassed(anchor, now, thresholds.wait_hub_hours)) return null
  const notPublishedAfter = thresholds.not_published_hours
  if (
    notPublishedAfter !== null &&
    hub.state === 'complete' &&
    hoursPassed(anchor, now, notPublishedAfter)
  ) {
    return {
      level: 'not_published',
      word: 'не вышло',
      detail: null,
      reason: `Прошло ${notPublishedAfter} ч, Hub видит все посты ${facts.account.label}, похожих нет`,
      date: null,
    }
  }
  return {
    level: 'cannot_verify',
    word: 'не проверено',
    detail: null,
    reason:
      hub.state === 'complete'
        ? `Hub не нашёл пост за ${thresholds.wait_hub_hours} ч`
        : coverageReason(hub, facts.account.label),
    date: null,
  }
}

function markedOutcome(facts: PlacementFacts, mark: NonNullable<PlanFacts['mark']>): Outcome {
  return {
    level: 'marked',
    word: 'отмечено',
    detail: null,
    reason: `${markReason(mark)} · ${hubSilenceReason(facts)}`,
    date: dateOf(mark.stated_occurred_at ?? mark.at),
  }
}

/** A mark where Hub does not check: Fansly stories and mass messages are final, the rest wait. */
function uncheckedMark(
  facts: PlacementFacts,
  mark: NonNullable<PlanFacts['mark']>,
  anchor: Instant,
): Outcome {
  const { account, surface, hub, thresholds, now } = facts
  if (account.platform === 'fansly' && (surface === 'story' || surface === 'dm')) {
    return {
      level: 'marked_manual',
      word: 'отмечено',
      detail: 'учёт вручную',
      reason: markReason(mark),
      date: dateOf(mark.stated_occurred_at ?? mark.at),
    }
  }
  const hubSwitchedOff = hub.state === 'off' || hub.state === 'unset'
  if (
    isCheckableSurface(account.platform, surface) &&
    hubSwitchedOff &&
    hoursPassed(anchor, now, thresholds.wait_hub_hours)
  ) {
    return {
      level: 'cannot_verify',
      word: 'не проверено',
      detail: null,
      reason: coverageReason(hub, account.label),
      date: null,
    }
  }
  return markedOutcome(facts, mark)
}

function fromMarkedPlan(
  facts: PlacementFacts,
  plan: PlanFacts,
  mark: NonNullable<PlanFacts['mark']>,
): Outcome {
  const autoChecked = isAutoChecked(facts.account.platform, facts.surface, facts.hub.state)
  const anchor = laterOf(slotInstant(plan), mark.at)
  if (mark.kind === 'scheduled') {
    const late = autoChecked ? afterWindow(facts, slotInstant(plan)) : null
    return (
      late ?? {
        level: 'scheduled',
        word: 'в планировщике',
        detail: null,
        reason: `Поставлено на ${plan.slot_time ?? 'весь день'}`,
        date: plan.slot_date,
      }
    )
  }
  if (!autoChecked) return uncheckedMark(facts, mark, anchor)
  return afterWindow(facts, anchor) ?? markedOutcome(facts, mark)
}

export function fromPlan(facts: PlacementFacts, plan: PlanFacts): Outcome {
  if (plan.mark) return fromMarkedPlan(facts, plan, plan.mark)
  if (instantMs(facts.now) >= instantMs(slotDeadline(plan))) {
    return {
      level: 'missed',
      word: 'пропущено',
      detail: null,
      reason: missedReason(plan, facts.now),
      date: plan.slot_date,
    }
  }
  return {
    level: 'planned',
    word: 'в плане',
    detail: null,
    reason: plannedReason(plan, factsToday(facts)),
    date: plan.slot_date,
  }
}
