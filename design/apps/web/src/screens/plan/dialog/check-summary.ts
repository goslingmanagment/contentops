import type { CreatePlanRowsResult, PlanWarning, RowCheckResult } from '@contentops/contracts'
import { capitalize, formatNumber, plural } from '@contentops/contracts'

/**
 * Строка проверки окна «В план» словами (DESIGN §4.13): что показать одной строкой из
 * ответов `rows:check` и предпросмотра пакета. Чистые правила, без запросов.
 */

export interface CheckSummary {
  tone: 'muted' | 'attention' | 'blocked'
  text: string
  thresholdUnset: boolean
}

/** Порядок янтаря: объект уже стоит на этом месте — первым, дальше повтор и время. */
const WARNING_RANK: Record<PlanWarning['kind'], number> = {
  already_planned: 0,
  too_early: 1,
  same_time: 2,
  too_close: 3,
  threshold_unset: 4,
}

function rankOf(result: RowCheckResult): number {
  if (result.blocked) {
    return -1
  }
  const first = result.warnings[0]
  return result.tone === 'attention' && first ? WARNING_RANK[first.kind] : 5
}

/** Ответ `rows:check` по одной выбранной странице. */
export interface PageCheck {
  /** «Fansly 2». */
  label: string
  result: RowCheckResult
}

function toneOf(checks: readonly PageCheck[]): CheckSummary['tone'] {
  if (checks.some((check) => check.result.blocked)) {
    return 'blocked'
  }
  return checks.some((check) => check.result.tone === 'attention') ? 'attention' : 'muted'
}

/**
 * Одна строка по всем выбранным страницам: у одной страницы — её фраза целиком; у
 * нескольких — каждая страница своим ответом, важное первым (отказ, дальше янтарь по
 * `WARNING_RANK`): «Fansly 2: слишком рано, было 22.09 — сегодня · Fansly 1: не было».
 * Если сказать нечего — «Повторов нет · Fansly 1: не было · Fansly 2: не было».
 */
export function pickCheck(checks: readonly PageCheck[]): CheckSummary | null {
  const [only] = checks
  if (!only) {
    return null
  }
  const tone = toneOf(checks)
  const thresholdUnset = checks.some((check) =>
    check.result.warnings.some((warning) => warning.kind === 'threshold_unset'),
  )
  if (checks.length === 1) {
    return { tone, text: only.result.text, thresholdUnset }
  }
  const ordered = [...checks].sort((left, right) => rankOf(left.result) - rankOf(right.result))
  const parts = ordered.map((check) => `${check.label}: ${check.result.page_text}`).join(' · ')
  const calm = checks.every((check) => rankOf(check.result) === 5)
  return { tone, text: calm ? `Повторов нет · ${parts}` : parts, thresholdUnset }
}

/** Пометка строки пакета в предпросмотре. */
export interface RowNote {
  tone: 'attention' | 'blocked'
  text: string
  /** Чем важнее, тем меньше: отказ −1, дальше янтарь по `WARNING_RANK`. */
  rank: number
}

/** Пометки строк пакета по ответу предпросмотра. */
export function batchNotes(
  count: number,
  result: CreatePlanRowsResult | undefined,
): (RowNote | null)[] {
  return Array.from({ length: count }, (_, index): RowNote | null => {
    const rejected = result?.rejected.find((entry) => entry.index === index)
    if (rejected) {
      return { tone: 'blocked', text: rejected.text, rank: -1 }
    }
    const warning = result?.rows[index]?.warnings[0]
    return warning
      ? { tone: 'attention', text: warning.text, rank: WARNING_RANK[warning.kind] }
      : null
  })
}

/**
 * Одна строка под формой: самая важная пометка полной фразой и сколько ещё строк с такой же
 * бедой — «… · ещё 3 такие строки».
 */
export function batchSummary(notes: readonly (RowNote | null)[]): CheckSummary {
  const marked = notes.filter((note): note is RowNote => note !== null)
  const first = marked.reduce<RowNote | null>(
    (best, note) => (best === null || note.rank < best.rank ? note : best),
    null,
  )
  if (!first) {
    return { tone: 'muted', text: 'Повторов нет', thresholdUnset: false }
  }
  const more = marked.filter((note) => note.rank === first.rank).length - 1
  const tail =
    more > 0
      ? ` · ещё ${formatNumber(more)} ${plural(more, ['такая строка', 'такие строки', 'таких строк'])}`
      : ''
  return { tone: first.tone, text: `${capitalize(first.text)}${tail}`, thresholdUnset: false }
}
