import {
  type Account,
  CANCEL_REASON_LABEL,
  formatNumber,
  formatPercent,
  formatShortDay,
  type LocalDate,
  type LocalTime,
  type PersonRef,
  type PlacementLevel,
  type PlanRow,
  plural,
  SURFACE_LABEL,
  UNIQ_LEVEL_LABEL,
} from '@contentops/contracts'

/** Слова строк плана (DESIGN §4.11, §5.2): подписи, короткие причины, «сделано». */

/** Уровни, после которых у КМ шагов нет: строка сереет, высота та же (§4.11). */
const DONE_LEVELS: ReadonlySet<PlacementLevel> = new Set([
  'marked',
  'marked_manual',
  'scheduled',
  'confirmed_exact',
  'confirmed_hub_unmarked',
  'confirmed_manual',
  'confirmed_earlier',
  'confirmed_reupload',
])

export function isDoneRow(row: PlanRow): boolean {
  return DONE_LEVELS.has(row.verdict.level)
}

/** Строку ещё можно отметить: она в плане или пропущена. */
export function isOpenRow(row: PlanRow): boolean {
  return (
    row.cancelled === null && (row.verdict.level === 'planned' || row.verdict.level === 'missed')
  )
}

export function isAwaitingMontage(row: PlanRow): boolean {
  return row.manifest === null && row.awaiting_montage !== null
}

const NBSP = '\u00a0'

/** «ср 23, 03:00», «чт 24» — место строки словами; при переносе не рвётся. */
export function slotText(date: LocalDate, time: LocalTime | null): string {
  const day = formatShortDay(date).replace(' ', NBSP)
  return time ? `${day},${NBSP}${time}` : day
}

/** Название строки: объект или «ждёт монтаж из RAW-0214». */
export function rowTitle(row: PlanRow): string {
  if (row.manifest) {
    return row.manifest.title
  }
  return row.awaiting_montage ? `ждёт монтаж из ${row.awaiting_montage.from_item}` : 'без объекта'
}

/** Серая подпись под названием: «FYP-0801 · фуп · версия 1 · мягко», «PPV-076 · стена · выпуск». */
export function rowSubtitle(row: PlanRow): string {
  const parts: string[] = []
  if (row.manifest) {
    parts.push(row.manifest.item_id)
  }
  parts.push(
    row.surface === 'vault' && row.album ? `vault «${row.album}»` : SURFACE_LABEL[row.surface],
  )
  const version = row.manifest?.fyp_version
  if (version) {
    parts.push(`версия ${version.no}`, UNIQ_LEVEL_LABEL[version.level])
  }
  if (row.awaiting_montage) {
    const files = row.awaiting_montage.file_keys.length
    parts.push(`${formatNumber(files)} ${plural(files, ['файл', 'файла', 'файлов'])}`)
  }
  if (row.release_id) {
    parts.push('выпуск')
  } else if (row.note) {
    parts.push(row.note)
  }
  return parts.join(' · ')
}

/** «копия готова», «копия собирается 40 %». */
export function copyCaption(row: PlanRow): string | null {
  const copy = row.copy
  if (!copy) {
    return null
  }
  if (copy.state === 'ready') {
    return 'копия готова'
  }
  if (copy.state === 'building') {
    return `собирается ${formatPercent(copy.progress)}`
  }
  return 'копия не собралась'
}

/** «не успели · Диана»: причина чипом, если выбрали, и кто отменил. */
function cancelledCaption(row: PlanRow): string | null {
  const cancelled = row.cancelled
  if (!cancelled) {
    return null
  }
  const reason = cancelled.reason ? CANCEL_REASON_LABEL[cancelled.reason] : null
  return [reason, cancelled.by.name].filter(Boolean).join(' · ')
}

/** Короткая причина серым под словом состояния («время прошло, отметки нет»). */
export function rowCaption(row: PlanRow): string | null {
  const { verdict } = row
  if (verdict.detail) {
    return verdict.detail
  }
  switch (verdict.level) {
    case 'missed':
      return 'время прошло, отметки нет'
    case 'marked':
      return verdict.facts.hub
    case 'planned':
      return isAwaitingMontage(row) ? 'монтажа ещё нет' : copyCaption(row)
    case 'cannot_verify':
    case 'blocked_second_person':
      return verdict.reason
    case 'cancelled':
      return cancelledCaption(row)
    default:
      return null
  }
}

/**
 * Янтарная пометка под названием строки (§4.11): «слишком рано: на Fansly 2 было 13.09 —
 * 9 дней назад», «два поста в 20:00 · SET-074». Страница строки видна по группе.
 */
export function rowWarningCaption(row: PlanRow): string | null {
  const warning = row.warnings[0]
  if (!warning) {
    return null
  }
  if (warning.kind === 'same_time' && row.time) {
    return `два поста в ${row.time} · ${warning.other_item}`
  }
  return warning.text
}

/**
 * Короткая фраза интеграции для тесного места: «Hub недоступен с 13:52» из «Hub недоступен
 * с 13:52 · повтор через 8 мин», «Hub выключен» из «Hub выключен — отметки работают».
 */
export function integrationShort(text: string): string {
  return text.split(/ · | — /)[0] ?? text
}

/** «3 строки», «14 строк». */
export function rowsWord(count: number): string {
  return `${formatNumber(count)} ${plural(count, ['строка', 'строки', 'строк'])}`
}

/** Кто может выкладывать: те, кто ведёт страницы, и те, кому уже передавали строки. */
export function peopleOf(
  groups: readonly { assignee: PersonRef | null }[],
  rows: readonly PlanRow[],
): PersonRef[] {
  const people = new Map<string, PersonRef>()
  for (const person of [
    ...groups.map((group) => group.assignee),
    ...rows.map((row) => row.assignee),
  ]) {
    if (person) {
      people.set(person.id, person)
    }
  }
  return [...people.values()]
}

/**
 * «Fansly 1, 2, 3» вместо «Fansly 1, Fansly 2, Fansly 3»: общее начало подписи пишется
 * один раз, пока страницы идут подряд с тем же началом.
 */
export function pagesLabel(accounts: readonly Account[]): string {
  const parts: string[] = []
  let previousPrefix: string | null = null
  for (const account of accounts) {
    const match = /^(.*\s)(\S+)$/.exec(account.label)
    const prefix = match?.[1] ?? null
    const rest = match?.[2] ?? account.label
    parts.push(prefix !== null && prefix === previousPrefix ? rest : account.label)
    previousPrefix = prefix
  }
  return parts.join(', ')
}

/**
 * Короткое слово состояния для тесной ячейки недели (DESIGN §4.12): знак и слово, которое
 * помещается; полное — в подсказке. Короткие слова («сверить», «пропущено») остаются как есть.
 */
const SHORT_WORD: Record<string, string> = {
  'нельзя на OnlyFans': 'нельзя',
}

export function shortVerdictWord(word: string): string {
  return SHORT_WORD[word] ?? word
}
