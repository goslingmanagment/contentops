import type { CheckCase, PlanRow } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { PanelMain } from '@contentops/ui/components/panel-pin'
import { StatusWord } from '@contentops/ui/components/status-word'
import { cn } from '@contentops/ui/lib/utils'
import { Link } from '@tanstack/react-router'
import { ExternalLinkIcon } from 'lucide-react'
import { useCurrentModel } from '@/shell/model/model-context'
import { usePairActions } from '../actions/use-pair-actions'

/**
 * «Как дела» (DESIGN §4.11): три факта предложениями с автором и временем — план,
 * отметка, Hub; серые подписи под ними («Состав заменили после отметки»).
 */
export function RowFacts({ row }: { row: PlanRow }) {
  const { verdict } = row
  const facts = [verdict.facts.plan, verdict.facts.mark, verdict.facts.hub].flatMap((fact) =>
    fact ? [fact] : [],
  )
  return (
    <InfoSection
      title="Как дела"
      aside={
        <StatusWord sign={verdict.sign ?? undefined} detail={verdict.detail}>
          {verdict.word}
        </StatusWord>
      }
    >
      <ul className="flex flex-col gap-1.5 text-base">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {verdict.notes.length > 0 ? (
        <ul className="flex flex-col gap-1 text-ink-3 text-sm">
          {verdict.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </InfoSection>
  )
}

interface PairBlockProps {
  checkCase: CheckCase
  platformLabel: string
}

/**
 * Пара для ◆ «сверить» прямо в панели строки (DESIGN §4.11, §4.15): фраза сравнения,
 * ссылка на пост и «Это оно» / «Не то». Разбор сложных случаев — во вкладке «Сверить».
 */
export function PairBlock({ checkCase, platformLabel }: PairBlockProps) {
  const model = useCurrentModel().code
  const pair = usePairActions()
  const post = checkCase.posts[0]
  const single = checkCase.kind === 'candidate' && checkCase.posts.length === 1
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-attention-bg px-4 py-3">
      {checkCase.pair_phrase ? (
        <p className={cn('text-base', checkCase.pair_matches === false && 'text-destructive')}>
          {checkCase.pair_phrase}
        </p>
      ) : (
        <p className="text-base">{checkCase.verdict.reason}</p>
      )}
      {checkCase.hint ? <p className="text-ink-3 text-sm">{checkCase.hint}</p> : null}
      {/* Решение по паре — главная кнопка панели, в закреплённом верху (§3.4). */}
      <PanelMain>
        {single ? (
          <>
            <Button pending={pair.pending} onClick={() => pair.confirm(checkCase)}>
              Это оно
            </Button>
            <Button
              variant="outline"
              disabled={pair.pending}
              onClick={() => pair.reject(checkCase)}
            >
              Не то
            </Button>
          </>
        ) : (
          <Button asChild>
            <Link to="/$model/plan/check/$case" params={{ model, case: checkCase.id }}>
              Разобрать
            </Link>
          </Button>
        )}
      </PanelMain>
      {post ? (
        <Button variant="link" size="sm" asChild className="self-start">
          <a href={post.url} target="_blank" rel="noreferrer">
            Пост на {platformLabel}
            <ExternalLinkIcon />
          </a>
        </Button>
      ) : null}
    </div>
  )
}
