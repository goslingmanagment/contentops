import { formatDate, type Handoff, mskDate } from '@contentops/contracts'
import { InfoSection } from '@contentops/ui/components/info-panel'
import { cn } from '@contentops/ui/lib/utils'
import { useToday } from '@/data/api-session'
import { HandoffStatus } from '../shared/handoff-status'

interface HandoffHistoryProps {
  handoffs: readonly Handoff[]
  /** Передача, открытая в панели, — выделена. */
  currentId: string | null
  onPick: (handoffId: string) => void
}

/** Передачи этой подборки, новые сверху: досылка — отдельная строка (DESIGN §4.17). */
export function HandoffHistory({ handoffs, currentId, onPick }: HandoffHistoryProps) {
  const today = useToday()
  if (handoffs.length === 0) return null
  const newestFirst = [...handoffs].sort((left, right) =>
    right.created_at.localeCompare(left.created_at),
  )
  return (
    <InfoSection title="Передачи подборки">
      <ul className="-mx-2 flex flex-col">
        {newestFirst.map((handoff) => (
          <li key={handoff.id}>
            <button
              type="button"
              aria-current={handoff.id === currentId || undefined}
              onClick={() => onPick(handoff.id)}
              className={cn(
                'flex h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left transition-colors duration-120 hover:bg-accent',
                handoff.id === currentId && 'bg-primary-tint hover:bg-primary-tint',
              )}
            >
              <span className="w-11 shrink-0 text-muted-foreground text-sm tabular-nums">
                {formatDate(mskDate(handoff.created_at), today)}
              </span>
              <span className="min-w-0 flex-1 truncate text-base">{handoff.contractor_name}</span>
              <HandoffStatus
                status={handoff.status}
                progress={handoff.state === 'preparing' ? handoff.progress : null}
                short
                className="w-28 shrink-0"
              />
            </button>
          </li>
        ))}
      </ul>
    </InfoSection>
  )
}
