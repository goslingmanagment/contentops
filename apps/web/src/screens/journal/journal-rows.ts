import { type JournalEvent, type LocalDate, mskDate } from '@contentops/contracts'

/**
 * Лента журнала как плоский список строк для виртуального списка: заголовок дня, событие
 * и, если оно раскрыто, строка «было → стало» под ним. Высоты фиксированы и считаются
 * заранее, поэтому строки не прыгают (DESIGN §3.13, §7.3).
 */
export type JournalRow =
  | { kind: 'day'; key: string; date: LocalDate }
  | { kind: 'event'; key: string; event: JournalEvent; expanded: boolean }
  | { kind: 'details'; key: string; event: JournalEvent }
  | { kind: 'more'; key: string }

const DAY_HEIGHT = 44
const EVENT_HEIGHT = 48
const MORE_HEIGHT = 48
const DETAILS_PADDING = 16
const DETAILS_LINE = 24

/** Строк в раскрытии: по одной на изменение поля и одна с датой, областью и автором. */
export function detailsLineCount(event: JournalEvent): number {
  return event.changes.length + 1
}

export function journalRowHeight(row: JournalRow): number {
  switch (row.kind) {
    case 'day':
      return DAY_HEIGHT
    case 'event':
      return EVENT_HEIGHT
    case 'details':
      return DETAILS_PADDING + detailsLineCount(row.event) * DETAILS_LINE
    case 'more':
      return MORE_HEIGHT
  }
}

export function isEventRow(row: JournalRow): boolean {
  return row.kind === 'event'
}

export function journalRowKey(row: JournalRow): string {
  return row.key
}

/** События приходят от новых к старым; день открывается своим заголовком. */
export function buildJournalRows(
  events: readonly JournalEvent[],
  expanded: ReadonlySet<string>,
  hasMore: boolean,
): JournalRow[] {
  const rows: JournalRow[] = []
  let day: LocalDate | null = null
  for (const event of events) {
    const date = mskDate(event.at)
    if (date !== day) {
      day = date
      rows.push({ kind: 'day', key: `day:${date}`, date })
    }
    const open = expanded.has(event.id)
    rows.push({ kind: 'event', key: event.id, event, expanded: open })
    if (open) {
      rows.push({ kind: 'details', key: `details:${event.id}`, event })
    }
  }
  if (hasMore) {
    rows.push({ kind: 'more', key: 'more' })
  }
  return rows
}
