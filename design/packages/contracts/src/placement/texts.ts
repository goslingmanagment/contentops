import { addDays, mskDate, mskInstant } from '../clock'
import type { Instant, LocalDate } from '../domain/common'
import type {
  Evidence,
  HubCoverage,
  PersonName,
  PlacementFacts,
  PlanFacts,
  ThreeFacts,
} from '../domain/placement'
import { CANCEL_REASON_LABEL, SURFACE_LABEL } from '../domain/placement'
import { formatClock, formatDate, formatPercent, formatSpan, pastVerb } from '../format'

/** Sentences of «почему» and of the three facts. Only words, no norm retelling. */

export function slotInstant(plan: Pick<PlanFacts, 'slot_date' | 'slot_time'>): Instant {
  return plan.slot_time ? mskInstant(plan.slot_date, plan.slot_time) : mskInstant(plan.slot_date)
}

/** Moment after which an unmarked row is missed: the slot, or the end of an all-day slot. */
export function slotDeadline(plan: Pick<PlanFacts, 'slot_date' | 'slot_time'>): Instant {
  if (plan.slot_time) return mskInstant(plan.slot_date, plan.slot_time)
  return mskInstant(addDays(plan.slot_date, 1))
}

/** Today by Moscow for the facts: the one reference of the date rule («22.09» / «22.09.2025»). */
export function factsToday(facts: Pick<PlacementFacts, 'now'>): LocalDate {
  return mskDate(facts.now)
}

function dayAndTime(date: LocalDate, time: string | null, today: LocalDate): string {
  const day = formatDate(date, today)
  return time ? `${day}, ${time}` : day
}

function by(person: PersonName, verb: string): string {
  return `${pastVerb(verb, person.gender)} ${person.name}`
}

function copyText(plan: PlanFacts): string | null {
  if (!plan.copy) return null
  if (plan.copy.state === 'ready') return 'копия готова'
  if (plan.copy.state === 'building') return `копия собирается ${formatPercent(plan.copy.progress)}`
  return 'копия не собралась'
}

export function plannedReason(plan: PlanFacts, today: LocalDate): string {
  if (plan.awaiting_montage_from) return `Ждёт монтаж из ${plan.awaiting_montage_from}`
  const when = plan.slot_time ? `В плане на ${plan.slot_time}` : 'В плане на весь день'
  const parts = [
    when,
    `${by(plan.created_by, 'поставил')} ${formatDate(mskDate(plan.created_at), today)}`,
  ]
  const copy = copyText(plan)
  if (copy) parts.push(copy)
  return parts.join(' · ')
}

export function missedReason(plan: PlanFacts, now: Instant): string {
  const minutes = (Date.parse(now) - Date.parse(slotDeadline(plan))) / 60_000
  return `Время прошло ${formatSpan(minutes)} назад, отметки нет`
}

export function markReason(mark: NonNullable<PlanFacts['mark']>): string {
  const at = mark.stated_occurred_at ?? mark.at
  return `${by(mark.by, 'Отметил')} ${formatClock(at)}`
}

export function coverageReason(hub: HubCoverage, accountLabel: string): string {
  switch (hub.state) {
    case 'partial':
      return 'Hub видит не все посты этой страницы'
    case 'off':
      return `Hub выключен для ${accountLabel}`
    case 'unset':
      return `Hub для ${accountLabel} не настроен`
    case 'down':
      return hub.since
        ? `Hub недоступен для ${accountLabel} с ${formatClock(hub.since)}`
        : `Hub недоступен для ${accountLabel}`
    case 'complete':
      return 'Hub ещё не видел'
  }
}

export function unknownReason(facts: PlacementFacts): string {
  const base = 'Плана, отметок и постов Hub нет'
  if (facts.hub.visible_from && facts.hub.state !== 'unset' && facts.hub.state !== 'off') {
    return `${base}. Hub видит ${facts.account.label} с ${formatDate(facts.hub.visible_from, factsToday(facts))}`
  }
  return base
}

export function cancelledReason(cancelled: NonNullable<PlanFacts['cancelled']>): string {
  const reason = cancelled.reason ? ` · ${CANCEL_REASON_LABEL[cancelled.reason]}` : ''
  return `Отменена${reason} · ${cancelled.by.name}`
}

function dated(person: PersonName, at: Instant, today: LocalDate): string {
  return `${person.name} ${formatDate(mskDate(at), today)}`
}

/** A line of «Как проверяли». */
export function describeEvidence(evidence: Evidence, today: LocalDate): string {
  switch (evidence.kind) {
    case 'hub_exact':
      return evidence.match === 'album'
        ? `Hub видит файл в альбоме · ${formatDate(mskDate(evidence.post_at), today)}`
        : `Hub: пост ${formatClock(evidence.post_at)} по имени файла`
    case 'hub_candidate':
      return `Hub нашёл похожее: пост ${formatClock(evidence.post_at)}, ${signedMinutes(evidence.offset_min)}`
    case 'hub_partial':
      return `Hub: совпало ${evidence.matched} из ${evidence.total}, ${evidence.missing}`
    case 'hub_mismatch':
      return `Hub: ${mismatchLabel(evidence.field)} ${evidence.ours} и ${evidence.theirs}`
    case 'hub_conflict':
      return `Hub видит в это время ${evidence.other}`
    case 'hub_surface_unknown':
      return `Hub: файл совпал точно, пост ${formatClock(evidence.post_at)}`
    case 'hub_unplanned':
      return `Hub видел: ${SURFACE_LABEL[evidence.surface_seen]} ${formatClock(evidence.post_at)} · ${evidence.summary}`
    case 'vault_missing':
      return `Альбом «${evidence.album}» обойдён ${formatDate(evidence.walked_on, today)}, файла нет`
    case 'vault_stale':
      return `В альбоме файл от ${formatDate(evidence.file_on, today)}`
    case 'vault_reupload':
      return `Новый файл на платформе ${formatDate(evidence.file_on, today)}`
    case 'manual_confirm':
      return evidence.basis === 'pair'
        ? `Это оно · ${dated(evidence.by, evidence.recorded_at, today)}`
        : `Отчёт о выполнении · ${dated(evidence.by, evidence.recorded_at, today)}`
    case 'manual_earlier':
      return `Подтверждено вручную ${formatDate(evidence.confirmed_on, today)}`
    case 'manual_reject':
      return `Не то · ${dated(evidence.by, evidence.recorded_at, today)}`
    case 'legacy_claim':
      return `В старом имени: ${evidence.label} · ${formatDate(evidence.on, today)}`
    case 'outside_catalog':
      return `Не наше · ${dated(evidence.by, evidence.recorded_at, today)}`
    case 'walk_not_found':
      return `Не найден при обходе от ${formatDate(evidence.walked_from, today)}`
  }
}

export function mismatchLabel(field: 'duration' | 'attachments'): string {
  return field === 'duration' ? 'длительность' : 'вложения'
}

export function signedMinutes(minutes: number): string {
  const rounded = Math.round(minutes)
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded)} мин`
}

function markSentence(mark: PlanFacts['mark'], today: LocalDate): string {
  if (!mark) return 'Отметки нет'
  const at = mark.stated_occurred_at ?? mark.at
  const when = `${formatDate(mskDate(at), today)} в ${formatClock(at)}`
  if (mark.kind === 'scheduled') {
    return `${pastVerb('Поставил', mark.by.gender)} в планировщик ${mark.by.name} ${when}`
  }
  return `${pastVerb('Отметил', mark.by.gender)} ${mark.by.name} ${when}`
}

/** The three facts, each one sentence with author and time. */
export function threeFacts(facts: PlacementFacts, hubSentence: string | null): ThreeFacts {
  const plan = facts.plan
  if (!plan) return { plan: null, mark: null, hub: hubSentence }
  const today = factsToday(facts)
  return {
    plan: `В плане на ${dayAndTime(plan.slot_date, plan.slot_time, today)} · ${by(plan.created_by, 'поставил')}`,
    mark: markSentence(plan.mark, today),
    hub: hubSentence,
  }
}
