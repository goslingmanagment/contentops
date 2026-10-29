import { formatWhen, type ItemId, type JournalEvent } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { ListRowSkeleton } from '@contentops/ui/components/skeletons'
import { ErrorLine } from '@contentops/ui/components/state-lines'
import { useNavigate } from '@tanstack/react-router'
import { BotIcon, CpuIcon, type LucideIcon, UserIcon } from 'lucide-react'
import { useClock } from '@/data/api-session'
import { useJournal } from '@/data/journal'
import { useCurrentModel } from '@/shell/model/model-context'

const EVENTS_IN_PANEL = 8

const ACTOR_ICON: Record<JournalEvent['actor']['type'], LucideIcon> = {
  person: UserIcon,
  agent: BotIcon,
  system: CpuIcon,
}

/**
 * Вкладка «История» панели: последние события модели или объекта, как в Журнале
 * (DESIGN §4.18), и ссылка на весь журнал с тем же фильтром.
 */
export function RecentEvents({ item }: { item?: ItemId }) {
  const model = useCurrentModel().code
  const journal = useJournal(model, item ? { item } : {})
  const now = useClock().now()
  const navigate = useNavigate()
  const events = journal.data?.pages.flatMap((page) => page.items).slice(0, EVENTS_IN_PANEL)

  if (journal.isError) {
    return <ErrorLine message="Не загрузилось" onRetry={() => void journal.refetch()} />
  }
  if (!events) {
    return (
      <div className="flex flex-col">
        {Array.from({ length: 4 }, (_, index) => (
          <ListRowSkeleton key={index} height={48} thumb="none" />
        ))}
      </div>
    )
  }
  if (events.length === 0) {
    return <p className="text-muted-foreground">Событий пока нет</p>
  }
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {events.map((event) => {
          const Icon = ACTOR_ICON[event.actor.type]
          return (
            <li key={event.id} className="flex gap-3">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
              <span className="flex min-w-0 flex-col">
                <span className={event.result === 'ok' ? 'text-sm' : 'text-destructive text-sm'}>
                  {event.phrase}
                </span>
                <span className="text-ink-3 text-xs tabular-nums">{formatWhen(event.at, now)}</span>
              </span>
            </li>
          )
        })}
      </ol>
      <Button
        variant="link"
        size="inline"
        className="self-start text-sm"
        onClick={() =>
          void navigate({ to: '/$model/journal', params: { model }, search: item ? { item } : {} })
        }
      >
        Весь журнал
      </Button>
    </div>
  )
}
