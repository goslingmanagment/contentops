import type {
  AccountCode,
  CatalogEntry,
  IsoWeek,
  LocalDate,
  SurfaceKind,
  UniqLevel,
} from '@contentops/contracts'
import { useMemo, useState } from 'react'
import { usePlanItems } from '@/data/plan'
import { isPlaced, type SpreadMode, type SpreadRow, spreadRows, spreadToNewRow } from './spread'
import type { DialogData } from './use-dialog-data'

/** Что выбрано в окне: страницы, место, неделя, раскладка, день и уровень версий. */
export interface SpreadChoice {
  accounts: readonly AccountCode[]
  surface: SurfaceKind
  mode: SpreadMode
  week: IsoWeek
  date: LocalDate
  level: UniqLevel
}

/**
 * Раскладка нескольких объектов с галочками: версии фупов подтягиваются с карточек,
 * снятые галочки помнятся по строке, строки без места не ставятся.
 */
export function useSpread(
  entries: readonly CatalogEntry[],
  data: DialogData,
  choice: SpreadChoice,
) {
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set())
  const fyps = entries.filter((entry) => entry.type === 'fyp').map((entry) => entry.id)
  const details = usePlanItems(data.model.code, choice.surface === 'fyp' ? fyps : [])
  const versions = useMemo(
    () => new Map(details.items.map((item) => [item.entry.id, item.fyp_versions])),
    [details.items],
  )
  const { accounts, surface, mode, week, date } = choice
  const rows = useMemo(
    () =>
      spreadRows({
        entries,
        accounts,
        surface,
        mode,
        week,
        date,
        today: data.today,
        gaps: data.gaps,
        norms: data.norms,
        versions,
      }),
    [entries, accounts, surface, mode, week, date, data, versions],
  )
  const chosen = rows.filter(isPlaced).filter((row) => !unchecked.has(row.key))
  return {
    rows,
    chosen,
    newRows: chosen.map((row) => spreadToNewRow(row, surface, choice.level)),
    isChecked: (row: SpreadRow) => isPlaced(row) && !unchecked.has(row.key),
    setChecked: (row: SpreadRow, checked: boolean) =>
      setUnchecked((current) => {
        const next = new Set(current)
        if (checked) {
          next.delete(row.key)
        } else {
          next.add(row.key)
        }
        return next
      }),
  }
}
