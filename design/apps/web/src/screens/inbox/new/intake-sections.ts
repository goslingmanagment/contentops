import { type InboxGroup, type InboxSection, inboxSectionOf } from '@contentops/contracts'

/**
 * Группы «Нового» по тому, что делать (DESIGN §4.8): «Нужно решение» (◆ и ▲), «Готово»,
 * «Готовится». Внутри — новые сверху, по времени приезда, как сортирует и сервер: решённая
 * группа, оставшись в своём разделе, остаётся и на своём месте.
 */

export interface IntakeSection {
  key: InboxSection
  title: string
  /** У «Готовится» числа нет. */
  counted: boolean
  /**
   * Группы раздела; их число — у заголовка. Решённая ◆ стоит на месте с новым словом до
   * перестройки (следующий вход на экран), и число меняется вместе с перестройкой, а не
   * раньше: сколько плиток под заголовком, столько и в числе.
   */
  groups: readonly InboxGroup[]
  /** Номер первой группы раздела в общем порядке. */
  start: number
}

/** Раздел, в котором группу увидели первой; пока человек на экране, она из него не уходит. */
export type SectionPins = Map<string, InboxSection>

/**
 * Запоминает раздел каждой новой группы (§1.7, §4.8): после «Этот заказ» или «Тип ▾»
 * группа стоит на месте с новым словом, сетка не перестраивается. Разделы собираются
 * заново при следующем входе на экран.
 */
export function pinSections(pins: SectionPins, groups: readonly InboxGroup[]): SectionPins {
  for (const group of groups) {
    const section = inboxSectionOf(group.state)
    if (section !== null && !pins.has(group.id)) {
      pins.set(group.id, section)
    }
  }
  return pins
}

const SECTIONS: readonly { key: InboxSection; title: string; counted: boolean }[] = [
  { key: 'decision', title: 'Нужно решение', counted: true },
  { key: 'ready', title: 'Готово', counted: true },
  { key: 'preparing', title: 'Готовится', counted: false },
]

export function buildSections(
  groups: readonly InboxGroup[],
  pins: ReadonlyMap<string, InboxSection> = new Map(),
): IntakeSection[] {
  const result: IntakeSection[] = []
  let start = 0
  for (const section of SECTIONS) {
    const inSection = groups
      .filter((group) => (pins.get(group.id) ?? inboxSectionOf(group.state)) === section.key)
      .toSorted((left, right) => right.arrived_at.localeCompare(left.arrived_at))
    if (inSection.length > 0) {
      result.push({ ...section, groups: inSection, start })
      start += inSection.length
    }
  }
  return result
}

export function flatten(sections: readonly IntakeSection[]): InboxGroup[] {
  return sections.flatMap((section) => section.groups)
}

/** При входе выбрана первая группа, с которой можно что-то сделать. */
export function firstActionable(sections: readonly IntakeSection[]): InboxGroup | undefined {
  const actionable = sections.find((section) => section.key !== 'preparing')
  return (actionable ?? sections[0])?.groups[0]
}

/**
 * Куда встать, когда группы ушли из списка: на следующую за последней ушедшей, а если
 * ушли последние — на предыдущую.
 */
export function nextAfterRemoval(
  order: readonly string[],
  removed: ReadonlySet<string>,
): string | null {
  const lastRemoved = order.reduce((last, key, index) => (removed.has(key) ? index : last), -1)
  if (lastRemoved < 0) {
    return null
  }
  const after = order.slice(lastRemoved + 1).find((key) => !removed.has(key))
  if (after !== undefined) {
    return after
  }
  return [...order.slice(0, lastRemoved)].reverse().find((key) => !removed.has(key)) ?? null
}

/**
 * Следующая группа, где нужен человек (§7.8): ◆, ▲ или «готово» — после этой, а если
 * дальше таких нет, то первая перед ней. «Готовится» пропускается.
 */
export function nextNeedingPerson(
  groups: readonly InboxGroup[],
  fromId: string,
): InboxGroup | undefined {
  const index = groups.findIndex((group) => group.id === fromId)
  const needs = (group: InboxGroup) =>
    group.id !== fromId && group.state.kind !== 'preparing' && inboxSectionOf(group.state) !== null
  return groups.slice(index + 1).find(needs) ?? groups.slice(0, Math.max(0, index)).find(needs)
}

export type Step = 'left' | 'right' | 'up' | 'down' | 'home' | 'end'

/**
 * Шаг стрелкой по сетке, разбитой на разделы: влево и вправо — по общему порядку, вверх
 * и вниз — на ряд внутри раздела или в ближний ряд соседнего раздела, в той же колонке.
 */
export function stepIndex(
  sizes: readonly number[],
  columns: number,
  index: number,
  step: Step,
): number {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total === 0) {
    return 0
  }
  const clamp = (value: number) => Math.min(total - 1, Math.max(0, value))
  if (step === 'left' || step === 'right') {
    return clamp(index + (step === 'right' ? 1 : -1))
  }
  if (step === 'home' || step === 'end') {
    return step === 'home' ? 0 : total - 1
  }
  const starts = sizes.map((_, section) => sizes.slice(0, section).reduce((a, b) => a + b, 0))
  const section = starts.findLastIndex((start) => start <= index)
  const start = starts[section] ?? 0
  const size = sizes[section] ?? 0
  const offset = index - start
  const column = offset % columns
  if (step === 'down') {
    if (offset + columns < size) {
      return index + columns
    }
    if (Math.floor(offset / columns) < Math.floor((size - 1) / columns)) {
      return start + size - 1
    }
    const next = sizes[section + 1]
    return next === undefined ? index : (starts[section + 1] ?? 0) + Math.min(column, next - 1)
  }
  if (offset >= columns) {
    return index - columns
  }
  const previous = sizes[section - 1]
  if (previous === undefined) {
    return index
  }
  const lastRow = Math.floor((previous - 1) / columns) * columns
  return (starts[section - 1] ?? 0) + Math.min(lastRow + column, previous - 1)
}
