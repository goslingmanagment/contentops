import type { LocalDate } from '../domain/common'
import type { Evidence, PlacementFacts, PlanFacts } from '../domain/placement'
import { formatClock, formatDate, formatDuration } from '../format'
import { type EvidenceOf, latest } from './evidence'
import { dateOf, type Outcome } from './outcome'
import { factsToday } from './texts'

/** ✓ levels (DESIGN §5.2): exact by Hub, manual, earlier manual, a new upload found. */

const EXACT_DETAIL: Record<EvidenceOf<'hub_exact'>['match'], string> = {
  file_name: 'Hub, по имени файла',
  album: 'Hub, в альбоме',
  file: 'Hub, тот же файл',
}

function exactReason(exact: EvidenceOf<'hub_exact'>, today: LocalDate): string {
  const date = formatDate(dateOf(exact.post_at), today)
  const duration = exact.duration
    ? ` · ${formatDuration(exact.duration.ours_s)} = ${formatDuration(exact.duration.theirs_s)}`
    : ''
  switch (exact.match) {
    case 'file_name':
      return `Пост ${formatClock(exact.post_at)} · имя \`${exact.file_name ?? ''}\`${duration}`
    case 'album':
      return `Hub видит файл в альбоме · ${date}`
    case 'file':
      return `Пост ${date} ${formatClock(exact.post_at)} · тот же файл${duration}`
  }
}

function exactOutcome(
  exact: EvidenceOf<'hub_exact'>,
  plan: PlanFacts | null,
  today: LocalDate,
): Outcome {
  const date = dateOf(exact.post_at)
  if (plan && !plan.mark) {
    return {
      level: 'confirmed_hub_unmarked',
      word: 'подтверждено',
      detail: 'Hub, без отметки',
      reason: `Пост ${formatClock(exact.post_at)} по имени файла; отметки КМ нет`,
      date,
    }
  }
  return {
    level: 'confirmed_exact',
    word: 'подтверждено',
    detail: EXACT_DETAIL[exact.match],
    reason: exactReason(exact, today),
    date,
  }
}

/**
 * A ✓ wins over everything but a cancelled row. When a new upload is required, only the
 * new file or a person's confirmation counts; the old file seen by Hub does not.
 */
export function confirmation(facts: PlacementFacts, evidence: readonly Evidence[]): Outcome | null {
  const plan = facts.plan
  const today = factsToday(facts)
  const reupload = latest(evidence, 'vault_reupload')
  if (reupload) {
    return {
      level: 'confirmed_reupload',
      word: 'подтверждено',
      detail: `новый файл ${formatDate(reupload.file_on, today)}`,
      reason: `Файл создан на платформе ${formatDate(reupload.file_on, today)}, позже строки`,
      date: reupload.file_on,
    }
  }
  const newUploadRequired = plan?.requires_new_upload === true
  const exact = newUploadRequired ? null : latest(evidence, 'hub_exact')
  if (exact) return exactOutcome(exact, plan, today)
  const manual = latest(evidence, 'manual_confirm')
  if (manual) {
    return {
      level: 'confirmed_manual',
      word: manual.by_agent ? 'подтверждено агентом' : 'подтверждено',
      detail: manual.by_agent ? manual.by.name : `вручную, ${manual.by.name}`,
      reason: manual.basis === 'pair' ? 'Осмотренная пара' : 'Отчёт о выполнении',
      date: dateOf(manual.recorded_at),
    }
  }
  const earlier = newUploadRequired ? null : latest(evidence, 'manual_earlier')
  if (earlier) {
    return {
      level: 'confirmed_earlier',
      word: 'подтверждено',
      detail: earlier.by_agent ? 'ранее агентом' : 'ранее вручную',
      reason: `Тот же файл платформы, подтверждён ${formatDate(earlier.confirmed_on, today)}`,
      date: earlier.confirmed_on,
    }
  }
  return null
}
