import {
  type AccountCode,
  formatNumber,
  type LocalDate,
  type ModelCode,
} from '@contentops/contracts'
import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from 'lucide-react'
import type { PlanDaySearch } from '../search'

interface MissedEarlierProps {
  model: ModelCode
  /** ▲ «пропущено» прошлых 7 дней (уже по «Мои»). */
  missed: readonly { date: LocalDate; account: AccountCode }[]
  /** Чипы страниц дня: пустой выбор — все страницы. */
  pages: readonly AccountCode[]
  search: PlanDaySearch
}

/**
 * «Пропущено раньше · 2 ›» (DESIGN §4.11): серая строка под заголовком сегодняшнего дня,
 * если за прошлые 7 дней есть ▲ «пропущено»; открывает ближайший такой день.
 */
export function MissedEarlier({ model, missed, pages, search }: MissedEarlierProps) {
  const shown = missed.filter((entry) => pages.length === 0 || pages.includes(entry.account))
  const nearest = shown.reduce<LocalDate | null>(
    (best, entry) => (best === null || entry.date > best ? entry.date : best),
    null,
  )
  if (!nearest) {
    return null
  }
  return (
    <Link
      to="/$model/plan/$date"
      params={{ model, date: nearest }}
      search={search}
      className="-mt-1 mb-1 inline-flex h-7 shrink-0 items-center gap-1 self-start text-muted-foreground text-sm hover:text-foreground"
    >
      Пропущено раньше · {formatNumber(shown.length)}
      <ChevronRightIcon className="size-4" />
    </Link>
  )
}
