import type { PlacementVerdict } from '@contentops/contracts'
import { StatusWord } from '@contentops/ui/components/status-word'
import { StopRowClick } from '@contentops/ui/components/stop-row-click'
import { type WhyAction, WhyPopover } from '@contentops/ui/components/why-popover'
import { cn } from '@contentops/ui/lib/utils'

/** Три факта «почему» строками: план, отметка, Hub (DESIGN §5.1). */
export function verdictFacts(verdict: PlacementVerdict): string[] {
  const { plan, mark, hub } = verdict.facts
  return [plan, mark, hub].flatMap((fact) => (fact ? [fact] : []))
}

interface VerdictWordProps {
  verdict: PlacementVerdict
  /** Уточнение решённого («вручную, Диана») в той же строке; в строке очереди оно уходит вниз. */
  inlineDetail?: boolean
}

/** Слово состояния со знаком: у ◆ — сам случай («Hub нашёл похожее»), у решённого — итог. */
export function VerdictWord({ verdict, inlineDetail = true }: VerdictWordProps) {
  const open = verdict.sign === 'turn'
  const detail = open || !inlineDetail ? undefined : verdict.detail
  return (
    <StatusWord sign={verdict.sign ?? undefined} detail={detail}>
      {open ? (verdict.detail ?? verdict.word) : verdict.word}
    </StatusWord>
  )
}

interface CaseStatusProps {
  verdict: PlacementVerdict
  /** Одна кнопка во всплывашке «почему»: «Разобрать». */
  action?: WhyAction
  /**
   * Серый факт под словом: у ◆ — цифры пары («пост 03:06 · +6 мин · 0:09 = 0:09»), у
   * решённого — как решили («вручную, Диана»). `undefined` — одна строка, как в панели.
   */
  fact?: string | null
  className?: string
}

/**
 * Состояние в строке: знак и слово, под ним серым короткий факт. Нажатие на слово
 * открывает «почему» с тремя фактами (DESIGN §5.1, §5.2).
 */
export function CaseStatus({ verdict, action, fact, className }: CaseStatusProps) {
  return (
    <div className={cn('flex min-w-0 flex-col items-start gap-0.5', className)}>
      <StopRowClick>
        <WhyPopover
          hint={verdict.reason}
          tone={verdict.sign ?? undefined}
          title={
            <StatusWord sign={verdict.sign ?? undefined} detail={verdict.detail}>
              {verdict.word}
            </StatusWord>
          }
          facts={verdictFacts(verdict)}
          action={action}
        >
          <VerdictWord verdict={verdict} inlineDetail={fact === undefined} />
        </WhyPopover>
      </StopRowClick>
      {fact ? (
        <span className="w-full truncate text-ink-3 text-sm tabular-nums">{fact}</span>
      ) : null}
    </div>
  )
}
