import {
  formatNumber,
  type NormKind,
  plural,
  type UpdateWeekNormCommand,
  type WeekNorm,
} from '@contentops/contracts'

/** Дни недели в шапке сетки нормы, с понедельника. */
export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

/** День выпуска в выборе: «чт ▾». */
export const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

const KIND_FORMS: Record<NormKind, (count: number) => string> = {
  fyp: (count) => plural(count, ['фуп', 'фупа', 'фупов']),
  wall: (count) => `${plural(count, ['пост', 'поста', 'постов'])} на стену`,
  life_vault: () => 'лайф в vault',
  story: () => 'сториз',
}

/** «В неделю: 4 фупа · 7 постов на стену · 1 лайф в vault» (DESIGN §4.14). */
export function weekTotals(
  norm: Pick<UpdateWeekNormCommand, 'cells'>,
  hidden: ReadonlySet<NormKind> = new Set(),
): string {
  const parts = norm.cells.flatMap((cell) => {
    const total = cell.per_day.reduce((sum, count) => sum + count, 0)
    return total > 0 && !hidden.has(cell.kind)
      ? [`${formatNumber(total)} ${KIND_FORMS[cell.kind](total)}`]
      : []
  })
  return parts.length > 0 ? `В неделю: ${parts.join(' · ')}` : 'Нормы на эту страницу нет'
}

/** «раз в неделю», «раз в 2 недели». */
export function everyWeeksText(weeks: number): string {
  return weeks === 1
    ? 'раз в неделю'
    : `раз в ${formatNumber(weeks)} ${plural(weeks, ['неделю', 'недели', 'недель'])}`
}

/** Правка — всё, что редактируется: норма без страницы и версии записи. */
export function editableOf(norm: WeekNorm): UpdateWeekNormCommand {
  return {
    cells: norm.cells.map((cell) => ({ ...cell, per_day: [...cell.per_day] })),
    release: norm.release ? { ...norm.release } : null,
    usual_assignee: norm.usual_assignee,
    uniq_level: norm.uniq_level,
  }
}
