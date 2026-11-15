import { ChevronRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/** Блок «Сегодня»: заголовок ведёт на свой экран одним нажатием, внутри — несколько строк. */
export function TodayBlock({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string
  href: string
  linkLabel: string
  children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border p-4">
      <a
        href={href}
        className="group flex items-center gap-2 pb-2"
        aria-label={`${title}: ${linkLabel}`}
      >
        <h2 className="min-w-0 flex-1 truncate font-medium text-md">{title}</h2>
        <span className="flex shrink-0 items-center text-muted-foreground text-sm group-hover:text-primary">
          {linkLabel}
          <ChevronRightIcon className="size-4" aria-hidden />
        </span>
      </a>
      {children}
    </section>
  )
}

/** Одна строка блока: слева главное, справа тихое. */
export function TodayLine({ main, side }: { main: ReactNode; side?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-baseline gap-3 border-border border-t py-1.5 text-sm first:border-t-0">
      <span className="min-w-0 flex-1 truncate">{main}</span>
      {side ? <span className="shrink-0 text-muted-foreground">{side}</span> : null}
    </li>
  )
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-1.5 text-muted-foreground text-sm">{children}</p>
}
