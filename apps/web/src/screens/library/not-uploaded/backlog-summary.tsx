import { type Account, formatNumber, type ItemType, plural } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import type { PageBacklog } from '../shared/not-uploaded-index'

const FORMS: Partial<Record<ItemType, readonly [string, string, string]>> = {
  sexting: ['секстинг', 'секстинга', 'секстингов'],
  set: ['сет', 'сета', 'сетов'],
  fyp: ['фуп', 'фупа', 'фупов'],
}

/** «4 PPV», «14 сетов», «12 лайф» — как говорят в команде. */
function countOf(type: ItemType, count: number): string {
  const forms = FORMS[type]
  const word = forms ? plural(count, forms) : type === 'ppv' ? 'PPV' : 'лайф'
  return `${formatNumber(count)} ${word}`
}

/** Состав страницы одной строкой: «4 PPV · 14 сетов · 12 лайф · 488 фупов». */
export function backlogComposition(backlog: PageBacklog): string {
  const parts: string[] = []
  for (const [type, entries] of backlog.byType) {
    if (entries.length > 0) {
      parts.push(countOf(type, entries.length))
    }
  }
  return parts.join(' · ')
}

interface BacklogSummaryProps {
  account: Account
  backlog: PageBacklog | undefined
  coverageNote: string | null
}

/** Панель без выделения (DESIGN §3.4): что не залито на страницу вкладки. */
export function BacklogSummary({ account, backlog, coverageNote }: BacklogSummaryProps) {
  return (
    <InfoSection title={`Ещё не залито на ${account.label}`}>
      {backlog ? (
        <>
          <p>{backlogComposition(backlog) || 'Всё залито'}</p>
          {backlog.planned.length > 0 ? (
            <p className="text-ink-3">ещё {formatNumber(backlog.planned.length)} уже в плане</p>
          ) : null}
        </>
      ) : null}
      {coverageNote ? <p className="text-ink-3">{coverageNote}</p> : null}
    </InfoSection>
  )
}
