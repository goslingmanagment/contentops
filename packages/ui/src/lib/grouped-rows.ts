/**
 * Раскладка сетки с группами (DESIGN §4.3, §4.7): у каждой группы строка заголовка и ряды
 * плиток. Элементы нумеруются сквозь все группы — так их видят выделение и клавиатура.
 */

export interface GroupSpan {
  /** Номер первого элемента группы в сквозной нумерации. */
  start: number
  count: number
}

export type GroupedRow =
  | { kind: 'header'; group: number }
  | { kind: 'tiles'; group: number; start: number; end: number }
  | { kind: 'footer' }

export function groupSpans(counts: readonly number[]): GroupSpan[] {
  let start = 0
  return counts.map((count) => {
    const span = { start, count }
    start += count
    return span
  })
}

export function buildGroupedRows(
  spans: readonly GroupSpan[],
  columns: number,
  withFooter: boolean,
): GroupedRow[] {
  const rows: GroupedRow[] = []
  spans.forEach((span, group) => {
    rows.push({ kind: 'header', group })
    for (let offset = 0; offset < span.count; offset += columns) {
      rows.push({
        kind: 'tiles',
        group,
        start: span.start + offset,
        end: span.start + Math.min(span.count, offset + columns),
      })
    }
  })
  if (withFooter) {
    rows.push({ kind: 'footer' })
  }
  return rows
}

/** Ряд, в котором стоит элемент; `-1`, если такого элемента нет. */
export function rowOfIndex(rows: readonly GroupedRow[], index: number): number {
  return rows.findIndex((row) => row.kind === 'tiles' && index >= row.start && index < row.end)
}

function spanOf(spans: readonly GroupSpan[], index: number): number {
  return spans.findIndex((span) => index >= span.start && index < span.start + span.count)
}

/**
 * Соседний ряд для стрелок вверх и вниз: та же колонка, а если ряд короче — его последний
 * элемент. Из последнего ряда группы стрелка переходит в первый ряд следующей непустой
 * группы (и наоборот).
 */
export function verticalNeighbour(
  spans: readonly GroupSpan[],
  columns: number,
  index: number,
  direction: 1 | -1,
): number {
  const group = spanOf(spans, index)
  const span = spans[group]
  if (!span) {
    return index
  }
  const local = index - span.start
  const column = local % columns
  const target = (Math.floor(local / columns) + direction) * columns
  if (target >= 0 && target < span.count) {
    return span.start + Math.min(target + column, span.count - 1)
  }
  for (let next = group + direction; next >= 0 && next < spans.length; next += direction) {
    const candidate = spans[next]
    if (candidate && candidate.count > 0) {
      const rowStart = direction > 0 ? 0 : Math.floor((candidate.count - 1) / columns) * columns
      return candidate.start + Math.min(rowStart + column, candidate.count - 1)
    }
  }
  return index
}
