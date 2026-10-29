import type { NewPlanRow } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { useNavigate } from '@tanstack/react-router'
import { usePlanPreview, useRowChecks } from '@/data/plan'
import { useRole } from '@/data/session'
import { useCurrentModel } from '@/shell/model/model-context'
import { batchNotes, batchSummary, type CheckSummary, pickCheck } from './check-summary'

export type { CheckSummary, RowNote } from './check-summary'

/**
 * Проверка будущих строк тем же `rows:check`, что у агента (DESIGN §4.13): ответы по
 * каждой строке, на экране — одна строка словами по всем выбранным страницам. Строка
 * появляется, только когда ответили все страницы: неполных состояний человек не видит.
 */
export function useCheckSummary(rows: readonly NewPlanRow[]) {
  const model = useCurrentModel()
  const checks = useRowChecks(model.code, rows)
  const labelOf = (code: string) =>
    model.accounts.find((account) => account.code === code)?.label ?? code
  const answered = checks.flatMap((check, index) => {
    const row = rows[index]
    return check.data && row ? [{ label: labelOf(row.account), result: check.data }] : []
  })
  const complete = rows.length > 0 && answered.length === rows.length
  return {
    summary: complete ? pickCheck(answered) : null,
    /** Проверка каждой строки по порядку: пометка у строки в предпросмотре. */
    perRow: checks.map((check) => check.data),
    pending: checks.some((check) => check.isPending),
  }
}

/**
 * Проверка пакета одним запросом — предпросмотром `rows?dry_run=1` (DESIGN §4.12–4.13):
 * выпуск и раскладка дают до 21 строки, по запросу на строку заглушка ответила бы 429.
 * У каждой строки — её пометка, под формой — одна строка словами.
 */
export function useBatchCheck(rows: readonly NewPlanRow[]) {
  const model = useCurrentModel().code
  const preview = usePlanPreview(model, rows)
  const notes = batchNotes(rows.length, preview.data)
  const summary = rows.length === 0 || !preview.data ? null : batchSummary(notes)
  return { summary, notes, pending: preview.isFetching }
}

const TONE_CLASS: Record<CheckSummary['tone'], string> = {
  muted: 'text-muted-foreground',
  attention: 'text-attention-ink',
  blocked: 'text-destructive',
}

/** Сколько строк держит место под проверку: несколько страниц — две, иначе одна. */
export function checkLinesFor(rowCount: number): 1 | 2 {
  return rowCount > 1 ? 2 : 1
}

const RESERVE_CLASS: Record<1 | 2, string> = { 1: 'min-h-5', 2: 'min-h-10' }

/**
 * Одна строка проверки под формой (§4.13): серым или янтарём. У порога, который не задан,
 * владелец видит «задать». Пока проверка не готова, место под неё уже занято нужной
 * высотой — окно не прыгает.
 */
export function CheckLine({
  summary,
  lines = 1,
}: {
  summary: CheckSummary | null
  /** Сколько строк держать под проверку до и после ответа. */
  lines?: 1 | 2
}) {
  const role = useRole()
  const navigate = useNavigate()
  return (
    <p
      aria-live="polite"
      aria-busy={summary ? undefined : true}
      className={cn('flex min-w-0 items-baseline gap-1.5 text-base', RESERVE_CLASS[lines])}
    >
      {summary ? (
        <>
          <span className={cn('line-clamp-2 text-pretty', TONE_CLASS[summary.tone])}>
            {summary.text}
          </span>
          {summary.thresholdUnset && role === 'owner' ? (
            <Button
              type="button"
              variant="link"
              size="inline"
              onClick={() => void navigate({ to: '/settings/$tab', params: { tab: 'thresholds' } })}
            >
              задать
            </Button>
          ) : null}
        </>
      ) : null}
    </p>
  )
}
