import {
  type Account,
  formatNumber,
  type Instant,
  type LocalDate,
  type ResolvedCase,
} from '@contentops/contracts'
import { InfoPanel, type InfoPanelTab } from '@contentops/ui/components/info-panel'
import { StatusWord } from '@contentops/ui/components/status-word'
import { Fragment } from 'react'
import type { ClosedView } from '@/data/check'
import { RecentEvents } from '@/objects/recent-events'
import { postMoment, subjectSubtitle, subjectTitle } from './case-text'
import { DecisionWord, decisionLine, UndoButton } from './closed-case'
import { OurThumb, PostLink } from './pair/pair-sides'
import type { CaseDecisions } from './use-case-decisions'

interface ClosedPanelProps {
  entry: ResolvedCase
  view: ClosedView
  account: Account | undefined
  now: Instant
  today: LocalDate
  canDecide: boolean
  decisions: CaseDecisions
  width: 'wide' | 'narrow'
  onClose: () => void
}

/**
 * Пара решённого: наша миниатюра, время поста, о котором решили, и ссылка на него; состав
 * и сравнение — в «Как проверяли». У поста без нашего объекта подпись, время и состав уже
 * в шапке панели — остаётся ссылка на пост.
 */
function ClosedPair({ entry, pageLabel }: { entry: ResolvedCase; pageLabel: string }) {
  const { post } = entry
  if (!entry.item_id) {
    return post ? <PostLink url={post.url} pageLabel={pageLabel} /> : null
  }
  return (
    <div className="flex items-start gap-4">
      <OurThumb itemId={entry.item_id} />
      {post ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-base tabular-nums">{postMoment(post)}</p>
          <PostLink url={post.url} pageLabel={pageLabel} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Панель решённого случая (DESIGN §4.15): что решили, кто и как, пара на глазах,
 * «Отменить» или «Вернуть в разбор» и «Как проверяли» — оно остаётся в истории.
 */
export function ClosedPanel({
  entry,
  view,
  account,
  now,
  today,
  canDecide,
  decisions,
  width,
  onClose,
}: ClosedPanelProps) {
  const pageLabel = account?.label ?? entry.account
  const reopened = decisions.reopened.has(entry.case_id)
  const details: InfoPanelTab = {
    value: 'pair',
    label: 'Сведения',
    content: (
      <Fragment key={entry.case_id}>
        <header className="flex flex-col gap-1">
          <h2 className="text-lg">{subjectTitle(entry)}</h2>
          <p className="text-ink-3 text-sm tabular-nums">
            {entry.version_label ? `${entry.version_label} · ` : null}
            {pageLabel} · {subjectSubtitle(entry, today)}
          </p>
          {reopened ? <StatusWord>снова в разборе</StatusWord> : <DecisionWord entry={entry} />}
        </header>
        <ClosedPair entry={entry} pageLabel={pageLabel} />
        <div className="flex flex-col items-start gap-2">
          <p className="text-base text-muted-foreground tabular-nums">{decisionLine(entry, now)}</p>
          {canDecide && !reopened ? (
            <UndoButton entry={entry} view={view} decisions={decisions} />
          ) : null}
        </div>
        <section className="flex flex-col gap-1">
          <h3 className="text-ink-3 text-sm">
            Как проверяли · {formatNumber(entry.how_checked.length)}
          </h3>
          <ul className="flex flex-col gap-1 text-base">
            {entry.how_checked.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </Fragment>
    ),
  }
  const tabs = entry.item_id
    ? [
        details,
        { value: 'history', label: 'История', content: <RecentEvents item={entry.item_id} /> },
      ]
    : [details]
  return <InfoPanel width={width} onClose={onClose} tabs={tabs} />
}
