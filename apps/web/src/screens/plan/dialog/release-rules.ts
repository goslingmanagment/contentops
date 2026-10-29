import {
  type Account,
  type AccountCode,
  addDays,
  type CatalogEntry,
  daysBetween,
  type LocalDate,
  LocalDateSchema,
  type LocalTime,
  LocalTimeSchema,
  type NewPlanRow,
  type PageSummaryEntry,
  type Release,
  type WeekNorm,
  weekdayIndex,
} from '@contentops/contracts'
import { z } from 'zod'
import { alreadyThere, blockedReason } from './rules'

/** Столбцы матрицы выпуска (DESIGN §4.13): стена / рассылка / сториз-тизер / vault. */
export const RELEASE_SURFACES = ['wall', 'dm', 'story', 'vault'] as const
export type ReleaseSurface = (typeof RELEASE_SURFACES)[number]

export const RELEASE_SURFACE_LABEL: Record<ReleaseSurface, string> = {
  wall: 'стена',
  dm: 'рассылка',
  story: 'сториз-тизер',
  vault: 'vault',
}

const SlotSchema = z.object({ date: LocalDateSchema, time: LocalTimeSchema.nullable() })

/** Отмеченные ячейки «страница|место» и у каждого столбца свой день и время. */
export const ReleaseFormSchema = z.object({
  cells: z.array(z.string()).min(1, 'Отметьте хотя бы одну ячейку'),
  slots: z.object({ wall: SlotSchema, dm: SlotSchema, story: SlotSchema, vault: SlotSchema }),
})
export type ReleaseForm = z.infer<typeof ReleaseFormSchema>

export function cellKey(account: AccountCode, surface: ReleaseSurface): string {
  return `${account}|${surface}`
}

export function parseCell(key: string): { account: AccountCode; surface: ReleaseSurface } | null {
  const [account, surface] = key.split('|')
  const known = RELEASE_SURFACES.find((candidate) => candidate === surface)
  return account && known ? { account, surface: known } : null
}

/** «20:00» + 30 мин → «20:30». */
function laterTime(time: LocalTime, minutes: number): LocalTime {
  const total = (Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes) % (24 * 60)
  const hours = String(Math.floor(total / 60)).padStart(2, '0')
  return `${hours}:${String(total % 60).padStart(2, '0')}`
}

/**
 * День нового выпуска по норме (DESIGN §4.14): в свой день недели, не раньше сегодня и через
 * N недель после последнего выпуска в плане — новый выпуск не встаёт на день уже
 * стоящего.
 */
export function releaseDay(
  norms: readonly WeekNorm[],
  today: LocalDate,
  releases: readonly Pick<Release, 'date'>[] = [],
): LocalDate {
  const rule = norms.find((norm) => norm.release)?.release
  if (!rule) {
    return today
  }
  let day = addDays(today, (rule.weekday - weekdayIndex(today) + 7) % 7)
  const last = releases
    .map((release) => release.date)
    .sort()
    .at(-1)
  if (!last) {
    return day
  }
  const onCadence = (candidate: LocalDate) =>
    (daysBetween(last, candidate) / 7) % rule.every_weeks === 0
  while (day <= last || !onCadence(day)) {
    day = addDays(day, 7)
  }
  return day
}

/** Рассылка — на страницах, где стена по норме идёт почти каждый день (5 раз в неделю и чаще). */
function sendsMassMessages(norms: readonly WeekNorm[], account: AccountCode): boolean {
  const wall = norms
    .find((norm) => norm.account === account)
    ?.cells.find((cell) => cell.kind === 'wall')
  return (wall?.per_day.reduce((sum, count) => sum + count, 0) ?? 0) >= 5
}

interface ReleaseDefaultsInput {
  entry: CatalogEntry
  accounts: readonly Account[]
  norms: readonly WeekNorm[]
  summaries: readonly PageSummaryEntry[]
  today: LocalDate
  date: LocalDate | undefined
  /** Выпуски, что уже в плане: от последнего считается следующий по норме. */
  releases?: readonly Pick<Release, 'date'>[]
}

/**
 * Матрица, заполненная по виду PPV и норме: бандл — стена, рассылка, сториз-тизер;
 * в личку — vault, рассылка, сториз-тизер. Где объект уже был, и на OnlyFans со вторым
 * человеком ячейки пустые.
 */
export function releaseDefaults({
  entry,
  accounts,
  norms,
  summaries,
  today,
  date,
  releases = [],
}: ReleaseDefaultsInput): ReleaseForm {
  const kinds: readonly ReleaseSurface[] =
    entry.ppv_kind === 'dm' ? ['vault', 'dm', 'story'] : ['wall', 'dm', 'story']
  const cells = accounts.flatMap((account) => {
    if (blockedReason(entry, account)) {
      return []
    }
    const summary = summaries.find((candidate) => candidate.account === account.code)
    return kinds
      .filter((surface) => surface !== 'dm' || sendsMassMessages(norms, account.code))
      .filter((surface) => !alreadyThere(summary, surface))
      .map((surface) => cellKey(account.code, surface))
  })
  const day = date ?? releaseDay(norms, today, releases)
  const base = norms.find((norm) => norm.release)?.release?.time ?? '20:00'
  return {
    cells,
    slots: {
      wall: { date: day, time: base },
      story: { date: day, time: laterTime(base, 30) },
      dm: { date: day, time: laterTime(base, 60) },
      vault: { date: day, time: null },
    },
  }
}

/** Строки выпуска для проверки: та же `rows:check`, что у одной строки. */
export function releaseRows(entry: CatalogEntry, form: ReleaseForm): NewPlanRow[] {
  return form.cells.flatMap((key) => {
    const cell = parseCell(key)
    if (!cell) {
      return []
    }
    const slot = form.slots[cell.surface]
    return [
      {
        item_id: entry.id,
        account: cell.account,
        surface: cell.surface,
        date: slot.date,
        time: slot.time,
        fyp_version: null,
        assignee: null,
        note: null,
        requires_new_upload: false,
        awaiting_montage: null,
        marked: null,
      },
    ]
  })
}

/** Выпуск этого PPV, что уже стоит в плане: «Выпуск уже в плане: чт 24, 14 строк». */
export function existingRelease(
  entry: CatalogEntry,
  releases: readonly Release[],
): Release | undefined {
  return releases.find((release) => release.item_id === entry.id)
}
