import {
  addDays,
  formatDayMonthWords,
  type IsoWeek,
  isoWeekOf,
  type LocalDate,
  weekDates,
  weekStart,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton, type DownloadOption } from '@contentops/ui/components/download-button'
import { ItemMenuButton, type ItemMenuModel } from '@contentops/ui/components/item-menu'
import { Link } from '@tanstack/react-router'
import { ChevronLeftIcon, ChevronRightIcon, FolderUpIcon } from 'lucide-react'
import type { PlanWeekSearch } from '../search'

/** «21–27 сентября», через месяц — «28 сентября – 4 октября». */
function weekRangeText(week: IsoWeek): string {
  const dates = weekDates(week)
  const first = dates[0] ?? weekStart(week)
  const last = dates[6] ?? first
  if (first.slice(5, 7) === last.slice(5, 7)) {
    return `${Number(first.slice(8, 10))}–${formatDayMonthWords(last)}`
  }
  return `${formatDayMonthWords(first)} – ${formatDayMonthWords(last)}`
}

interface WeekNavProps {
  model: string
  week: IsoWeek
  today: LocalDate
  search: PlanWeekSearch
  drawerOpen: boolean
  onToggleDrawer: () => void
  /** «Скачать неделю ▾»: по страницам; `null` — нет прав. */
  download: {
    options: readonly DownloadOption[]
    onDownload: (id: string, strip: boolean) => void
  } | null
  menu: ItemMenuModel
}

/**
 * Строка недели 40 (DESIGN §4.12): «‹ 21–27 сентября ›», «Эта неделя», справа ящик
 * «Ещё не залито», «Скачать неделю ▾» и «⋯» недели.
 */
export function WeekNav({
  model,
  week,
  today,
  search,
  drawerOpen,
  onToggleDrawer,
  download,
  menu,
}: WeekNavProps) {
  const monday = weekStart(week)
  const link = (target: IsoWeek) => ({
    to: '/$model/plan/w/$week' as const,
    params: { model, week: target },
    search,
  })
  const thisWeek = isoWeekOf(today)
  return (
    <nav aria-label="Недели" className="flex h-10 shrink-0 items-center gap-1">
      <Button variant="ghost" size="icon-sm" asChild>
        <Link {...link(isoWeekOf(addDays(monday, -7)))} aria-label="Прошлая неделя">
          <ChevronLeftIcon />
        </Link>
      </Button>
      <h2 className="min-w-44 px-1 text-center font-medium text-lg">{weekRangeText(week)}</h2>
      <Button variant="ghost" size="icon-sm" asChild>
        <Link {...link(isoWeekOf(addDays(monday, 7)))} aria-label="Следующая неделя">
          <ChevronRightIcon />
        </Link>
      </Button>
      {week !== thisWeek ? (
        <Button variant="secondary" size="sm" className="ml-2" asChild>
          <Link {...link(thisWeek)}>Эта неделя</Link>
        </Button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button
          variant={drawerOpen ? 'outline' : 'secondary'}
          size="sm"
          aria-pressed={drawerOpen}
          onClick={onToggleDrawer}
        >
          <FolderUpIcon />
          Ещё не залито
        </Button>
        {download ? (
          <DownloadButton
            label="Скачать неделю"
            size="sm"
            options={download.options}
            onDownload={download.onDownload}
          />
        ) : null}
        {menu.actions.length > 0 ? (
          <ItemMenuButton menu={menu} size="icon-sm" label="Ещё о неделе" />
        ) : null}
      </div>
    </nav>
  )
}
