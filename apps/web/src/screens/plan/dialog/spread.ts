import {
  type AccountCode,
  type CatalogEntry,
  type FypVersion,
  type IsoWeek,
  type ItemId,
  type LocalDate,
  type LocalTime,
  type NewPlanRow,
  type SlotGap,
  type SurfaceKind,
  type UniqLevel,
  type WeekNorm,
  weekDates,
} from '@contentops/contracts'
import { pickVersions } from './fyp-versions'
import { normKindOf, normTime } from './rules'

/** Одна будущая строка предпросмотра «FYP-0801 → Fansly 2 · ср 23, 03:00 · версия 1». */
export interface SpreadRow {
  key: string
  item: ItemId
  account: AccountCode
  /** `null` — на этой странице места нормы кончились: строка не ставится. */
  date: LocalDate | null
  time: LocalTime | null
  version: { no: number; fresh: boolean } | null
}

export type SpreadMode = 'gaps' | 'day'

interface SpreadInput {
  entries: readonly CatalogEntry[]
  accounts: readonly AccountCode[]
  surface: SurfaceKind
  mode: SpreadMode
  week: IsoWeek
  /** «Все на один день». */
  date: LocalDate
  today: LocalDate
  gaps: readonly SlotGap[]
  norms: readonly WeekNorm[]
  versions: ReadonlyMap<ItemId, readonly FypVersion[]>
}

/** Пустые места нормы страницы на неделе по порядку, с сегодняшнего дня. */
function freePlaces(input: SpreadInput, account: AccountCode): SlotGap[] {
  const days = new Set(weekDates(input.week))
  const kind = normKindOf(input.surface)
  return input.gaps
    .filter(
      (gap) =>
        gap.account === account &&
        gap.kind === kind &&
        days.has(gap.date) &&
        gap.date >= input.today,
    )
    .sort((left, right) => `${left.date}${left.time}`.localeCompare(`${right.date}${right.time}`))
}

/**
 * Раскладка нескольких объектов (DESIGN §4.12–4.13): объект N встаёт на N-е пустое место
 * каждой страницы, так что ни один ролик не выбирается дважды; или все на один день.
 * Контент выбирает человек, система только раскладывает.
 */
export function spreadRows(input: SpreadInput): SpreadRow[] {
  const places = new Map(input.accounts.map((account) => [account, freePlaces(input, account)]))
  return input.entries.flatMap((entry, index) => {
    const picks =
      input.surface === 'fyp'
        ? pickVersions(input.versions.get(entry.id) ?? [], input.accounts)
        : []
    return input.accounts.map((account): SpreadRow => {
      const pick = picks.find((candidate) => candidate.account === account)
      const version = pick ? { no: pick.no, fresh: pick.fresh } : null
      if (input.mode === 'day') {
        return {
          key: `${entry.id}|${account}`,
          item: entry.id,
          account,
          date: input.date,
          time: normTime(input.norms, account, input.surface),
          version,
        }
      }
      const place = places.get(account)?.[index]
      return {
        key: `${entry.id}|${account}`,
        item: entry.id,
        account,
        date: place?.date ?? null,
        time: place?.time ?? null,
        version,
      }
    })
  })
}

export function spreadToNewRow(
  row: SpreadRow & { date: LocalDate },
  surface: SurfaceKind,
  level: UniqLevel,
): NewPlanRow {
  return {
    item_id: row.item,
    account: row.account,
    surface,
    date: row.date,
    time: row.time,
    fyp_version: row.version ? { no: row.version.no, level } : null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: null,
    marked: null,
  }
}

export function isPlaced(row: SpreadRow): row is SpreadRow & { date: LocalDate } {
  return row.date !== null
}
