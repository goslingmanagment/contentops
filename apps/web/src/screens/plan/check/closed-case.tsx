import { formatWhen, type Instant, type ResolvedCase } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { StatusWord } from '@contentops/ui/components/status-word'
import type { ClosedView } from '@/data/check'
import type { CaseDecisions } from './use-case-decisions'

/** Решённый случай в «Решённых» и «Не наше» (DESIGN §4.15): итог, кто и как, отмена. */

/** «Отменить» у решённого, «Вернуть в разбор» у не нашего. */
export const UNDO_LABEL: Record<ClosedView, string> = {
  done: 'Отменить',
  'not-ours': 'Вернуть в разбор',
}

function isConfirmed(entry: ResolvedCase): boolean {
  return entry.how === 'осмотренная пара' || entry.how === 'отчёт о выполнении'
}

/** Итог: ✓ «подтверждено» у подтверждённого, серое слово у «Не то» и «Не наше». */
export function DecisionWord({ entry }: { entry: ResolvedCase }) {
  return isConfirmed(entry) ? (
    <StatusWord sign="done">подтверждено</StatusWord>
  ) : (
    <StatusWord>{entry.how}</StatusWord>
  )
}

/** Кто решил · когда · как: «Диана · 20.09 10:20 · осмотренная пара». */
export function decisionLine(entry: ResolvedCase, now: Instant): string {
  const parts = [entry.by.name, formatWhen(entry.at, now)]
  return (isConfirmed(entry) ? [...parts, entry.how] : parts).join(' · ')
}

/** Как назвать случай в полоске после отмены: «FYP-0788» или «пост». */
export function closedLabel(entry: ResolvedCase): string {
  return entry.version_label ?? entry.item_id ?? 'пост'
}

interface UndoButtonProps {
  entry: ResolvedCase
  view: ClosedView
  decisions: CaseDecisions
  className?: string
}

/** «Отменить» / «Вернуть в разбор»: решение снимается, как проверяли — остаётся в истории. */
export function UndoButton({ entry, view, decisions, className }: UndoButtonProps) {
  return (
    <Button
      variant="outline"
      pending={decisions.pending?.caseId === entry.case_id}
      disabled={decisions.pending !== null && decisions.pending.caseId !== entry.case_id}
      onClick={() => decisions.undo(entry.case_id, closedLabel(entry))}
      className={className}
    >
      {UNDO_LABEL[view]}
    </Button>
  )
}
