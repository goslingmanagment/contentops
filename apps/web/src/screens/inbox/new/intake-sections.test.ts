import { buildLoraInbox } from '@contentops/contracts/fixtures/lora-inbox'
import { buildCasesInbox } from '@contentops/contracts/fixtures/lora-inbox-cases'
import { describe, expect, it } from 'vitest'
import {
  buildSections,
  firstActionable,
  flatten,
  nextAfterRemoval,
  nextNeedingPerson,
  pinSections,
  type SectionPins,
  stepIndex,
} from './intake-sections'

const activeOf = (records: ReturnType<typeof buildLoraInbox>) =>
  records
    .map((record) => record.group)
    .filter((group) => group.state.kind !== 'accepted' && group.state.kind !== 'rejected')

describe('разделы «Нового»', () => {
  it('идут «Нужно решение», «Готово», «Готовится»; у «Готовится» числа нет', () => {
    const sections = buildSections(activeOf(buildLoraInbox()))
    expect(sections.map((section) => [section.title, section.groups.length])).toEqual([
      ['Нужно решение', 4],
      ['Готово', 5],
      ['Готовится', 2],
    ])
    expect(sections.map((section) => section.counted)).toEqual([true, true, false])
    expect(sections.map((section) => section.start)).toEqual([0, 4, 9])
  })

  it('пустой раздел не рисуется, при входе выбрана первая группа с делом', () => {
    const readyOnly = activeOf(buildLoraInbox()).filter(
      (group) => group.state.kind === 'ready' || group.state.kind === 'preparing',
    )
    const sections = buildSections(readyOnly)
    expect(sections.map((section) => section.key)).toEqual(['ready', 'preparing'])
    expect(firstActionable(sections)?.title).toBe('Сеты · 21.09.26 · 22 фото')
  })

  it('в редких случаях все группы на месте и порядок сквозной', () => {
    const groups = flatten(buildSections(activeOf(buildCasesInbox())))
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length)
    expect(groups.length).toBeGreaterThan(15)
  })
})

describe('решённая группа стоит на месте', () => {
  it('после «Этот заказ» остаётся в «Нужно решение», и число меняется только с перестройкой', () => {
    const groups = activeOf(buildLoraInbox())
    const pins: SectionPins = new Map()
    pinSections(pins, groups)
    const decided = groups.map((group) =>
      group.id === 'g-2254'
        ? {
            ...group,
            state: {
              kind: 'ready' as const,
              note: { kind: 'order_part' as const, order_id: 'o', part: 'видео' },
            },
          }
        : group,
    )
    const sections = buildSections(decided, pinSections(pins, decided))
    // Решённая группа стоит в «Нужно решение» до перестройки — и в его числе тоже.
    expect(sections.map((section) => [section.key, section.groups.length])).toEqual([
      ['decision', 4],
      ['ready', 5],
      ['preparing', 2],
    ])
    expect(sections[0]?.groups[0]?.id).toBe('g-2254')
    // Сервер отдаёт готовое после решений: место в разделе держит время приезда.
    const serverOrder = [...decided.filter((group) => group.id !== 'g-2254'), decided[0]]
    const again = buildSections(
      serverOrder.filter((group) => group !== undefined),
      pins,
    )
    expect(again[0]?.groups.map((group) => group.id)).toEqual(
      sections[0]?.groups.map((group) => group.id),
    )
  })

  it('при новом входе разделы собираются по состоянию', () => {
    const groups = activeOf(buildLoraInbox()).map((group) =>
      group.id === 'g-1610'
        ? { ...group, state: { kind: 'ready' as const, note: { kind: 'new' as const } } }
        : group,
    )
    const sections = buildSections(groups, pinSections(new Map(), groups))
    expect(sections.map((section) => section.groups.length)).toEqual([3, 6, 2])
  })
})

describe('куда встать после «Повторить» и «Ждать»', () => {
  it('на следующую группу, где нужен человек, мимо «Готовится»', () => {
    const groups = flatten(buildSections(activeOf(buildLoraInbox())))
    expect(nextNeedingPerson(groups, 'g-1717')?.id).toBe('g-sets-2109')
    expect(nextNeedingPerson(groups, 'g-kp3')?.id).toBe('g-2254')
  })
})

describe('куда встать после решения', () => {
  const order = ['a', 'b', 'c', 'd']

  it('на следующую за ушедшей', () => {
    expect(nextAfterRemoval(order, new Set(['b']))).toBe('c')
  })

  it('после пакета — на следующую за последней ушедшей', () => {
    expect(nextAfterRemoval(order, new Set(['a', 'c']))).toBe('d')
  })

  it('если ушли последние — на предыдущую', () => {
    expect(nextAfterRemoval(order, new Set(['c', 'd']))).toBe('b')
  })

  it('если ничего не ушло или ушло всё — некуда', () => {
    expect(nextAfterRemoval(order, new Set())).toBeNull()
    expect(nextAfterRemoval(order, new Set(order))).toBeNull()
  })
})

describe('стрелки по сетке из разделов', () => {
  // Разделы по 4, 5 и 2 группы, три колонки.
  const sizes = [4, 5, 2]

  it('вправо и влево идут сквозь разделы', () => {
    expect(stepIndex(sizes, 3, 3, 'right')).toBe(4)
    expect(stepIndex(sizes, 3, 4, 'left')).toBe(3)
    expect(stepIndex(sizes, 3, 10, 'right')).toBe(10)
  })

  it('вниз — на ряд, с неполного ряда — в тот же столбец следующего раздела', () => {
    expect(stepIndex(sizes, 3, 1, 'down')).toBe(3)
    expect(stepIndex(sizes, 3, 3, 'down')).toBe(4)
    expect(stepIndex(sizes, 3, 5, 'down')).toBe(8)
    expect(stepIndex(sizes, 3, 8, 'down')).toBe(10)
  })

  it('вверх — в последний ряд предыдущего раздела, в тот же столбец', () => {
    expect(stepIndex(sizes, 3, 4, 'up')).toBe(3)
    expect(stepIndex(sizes, 3, 6, 'up')).toBe(3)
    expect(stepIndex(sizes, 3, 10, 'up')).toBe(8)
  })

  it('в списке колонка одна', () => {
    expect(stepIndex(sizes, 1, 3, 'down')).toBe(4)
    expect(stepIndex(sizes, 1, 0, 'up')).toBe(0)
    expect(stepIndex(sizes, 1, 5, 'end')).toBe(10)
  })
})
