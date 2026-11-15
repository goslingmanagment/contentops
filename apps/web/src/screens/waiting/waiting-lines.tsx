import { formatDate, mskDate } from '@contentops/contracts'
import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { useHref } from '@/app/use-href'
import { useClock } from '@/data/api-session'
import type { useWaiting } from '@/data/waiting'

type WaitingState = ReturnType<typeof useWaiting>

/**
 * Строки «Ждут вас»: свои строки ContentOps («Сверить 8») и дела из Hub. Дело Hub открывается там,
 * где его решают (Hub, Workboard или экран здесь); `limit` — первые строки для «Сегодня».
 */
export function WaitingLines({
  model,
  waiting,
  limit,
}: {
  model: string
  waiting: WaitingState
  limit?: number
}) {
  const href = useHref()
  const clock = useClock()
  const today = mskDate(clock.now())
  const params = { model }
  const own = waiting.own.map((line) => ({
    key: line.key,
    title: `${line.label} ${line.count}`,
    note: line.to === 'check' ? 'План' : 'Приехало',
    href:
      line.to === 'check'
        ? href({ to: '/$model/plan/check', params })
        : href({ to: '/$model/inbox', params }),
    outside: false,
  }))
  const hub = waiting.matters.map((matter) => ({
    key: `hub-${matter.id}`,
    title: matter.title,
    note: `Hub · ждёт с ${formatDate(mskDate(matter.opened_at), today)}`,
    href: matter.href,
    outside: !matter.href.startsWith('/'),
  }))
  const lines = [...own, ...hub].slice(0, limit ?? Number.POSITIVE_INFINITY)
  return (
    <ul className="flex flex-col">
      {lines.map((line) => (
        <li key={line.key} className="border-border border-b last:border-b-0">
          <a
            href={line.href}
            {...(line.outside ? { target: '_blank', rel: 'noreferrer' } : {})}
            className="flex min-h-12 items-center gap-3 py-2 hover:text-primary"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base">{line.title}</span>
              <span className="block truncate text-muted-foreground text-sm">{line.note}</span>
            </span>
            {line.outside ? (
              <ExternalLinkIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-label="в новой вкладке"
              />
            ) : (
              <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
          </a>
        </li>
      ))}
    </ul>
  )
}
