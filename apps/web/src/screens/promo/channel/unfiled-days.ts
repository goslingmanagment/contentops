import type { CollectionMember, LocalDate } from '@contentops/contracts'

export interface UnfiledDay {
  date: LocalDate
  /** Номер первого материала дня в общем порядке — для выделения диапазоном. */
  start: number
  members: CollectionMember[]
}

/** Материалы канала по дням добавления, новые дни сверху (DESIGN §4.17). */
export function unfiledDays(members: readonly CollectionMember[]): UnfiledDay[] {
  const byDate = new Map<LocalDate, CollectionMember[]>()
  for (const member of members) {
    byDate.set(member.added_on, [...(byDate.get(member.added_on) ?? []), member])
  }
  let start = 0
  return [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, dayMembers]) => {
      const day = { date, start, members: dayMembers }
      start += dayMembers.length
      return day
    })
}
