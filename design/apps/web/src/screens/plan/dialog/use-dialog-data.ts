import {
  type AccountCode,
  addDays,
  type IsoWeek,
  isoWeekOf,
  type LocalDate,
  mskDate,
  type SlotGap,
} from '@contentops/contracts'
import { useMemo } from 'react'
import { useClock } from '@/data/api-session'
import { useCatalogIndex, usePageSummaries } from '@/data/catalog'
import { usePlanWeek, useWeekNorms } from '@/data/plan'
import { useCurrentModel } from '@/shell/model/model-context'
import { peopleOf } from '../shared/plan-text'

/**
 * Всё, что окну «В план» нужно из индекса и плана: каталог, сводка по страницам, нормы
 * всех страниц и пустые места этой и следующей недели. Запросы общие с экранами — окно
 * открывается мгновенно из кэша (§3.13).
 */
export function useDialogData() {
  const model = useCurrentModel()
  const today = mskDate(useClock().now())
  const thisWeek = isoWeekOf(today)
  const nextWeek = isoWeekOf(addDays(today, 7))
  const catalog = useCatalogIndex(model.code)
  const summaries = usePageSummaries(model.code)
  const norms = useWeekNorms(
    model.code,
    model.accounts.map((account) => account.code),
  )
  const current = usePlanWeek(model.code, thisWeek)
  const next = usePlanWeek(model.code, nextWeek)
  const gaps = useMemo(
    () => [...(current.data?.gaps ?? []), ...(next.data?.gaps ?? [])],
    [current.data, next.data],
  )
  const rows = useMemo(
    () => [...(current.data?.rows ?? []), ...(next.data?.rows ?? [])],
    [current.data, next.data],
  )
  const releases = useMemo(() => {
    const byId = new Map(
      [...(current.data?.releases ?? []), ...(next.data?.releases ?? [])].map((release) => [
        release.id,
        release,
      ]),
    )
    return [...byId.values()]
  }, [current.data, next.data])
  const people = useMemo(() => peopleOf([], rows), [rows])
  return {
    model,
    today,
    weeks: { thisWeek, nextWeek } satisfies Record<string, IsoWeek>,
    catalog: catalog.data,
    summaries: summaries.data,
    norms: norms.norms,
    gaps,
    /** Строки этой и следующей недели: где сырьё уже ждёт монтаж, где стоит выпуск. */
    rows,
    /** Выпуски PPV этой и следующей недели. */
    releases,
    /** Кто выкладывает: имена из строк плана этой и следующей недели. */
    people,
    /** Сводка по страницам нужна до первого кадра: по ней отмечаются страницы по умолчанию. */
    ready: catalog.data !== undefined && summaries.data !== undefined && norms.ready,
  }
}

export type DialogData = ReturnType<typeof useDialogData>

/** Дни с пустыми местами нормы на этих страницах и этом месте: метки в выборе дня. */
export function gapDays(
  gaps: readonly SlotGap[],
  accounts: readonly AccountCode[],
  surface: SlotGap['surface'] | null,
): Set<LocalDate> {
  return new Set(
    gaps
      .filter(
        (gap) => accounts.includes(gap.account) && (surface === null || gap.surface === surface),
      )
      .map((gap) => gap.date),
  )
}

/** Первый день не раньше сегодня, где на этих страницах есть пустое место нормы. */
export function firstGapDay(
  data: Pick<DialogData, 'gaps' | 'today'>,
  accounts: readonly AccountCode[],
  surface: SlotGap['surface'] | null,
  from: LocalDate = data.today,
): LocalDate {
  const start = from > data.today ? from : data.today
  const days = [...gapDays(data.gaps, accounts, surface)].filter((day) => day >= start).sort()
  return days[0] ?? start
}
