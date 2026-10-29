import type { SlotGap } from '@contentops/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { type DialogTestWorld, loadDialogTestWorld } from './dialog-test-world'
import { isPlaced, spreadRows, spreadToNewRow } from './spread'

let world: DialogTestWorld

beforeAll(async () => {
  world = await loadDialogTestWorld()
})

function gap(date: string, account: string, time = '03:00'): SlotGap {
  return { date, account, kind: 'fyp', surface: 'fyp', time, text: 'Здесь нужен фуп' }
}

const GAPS: SlotGap[] = [
  gap('2026-09-21', 'lora-2'),
  gap('2026-09-26', 'lora-2'),
  gap('2026-09-24', 'lora-2'),
  gap('2026-09-25', 'lora-3'),
  gap('2026-09-30', 'lora-2'),
]

function input(overrides: Partial<Parameters<typeof spreadRows>[0]> = {}) {
  return {
    entries: [world.entry('FYP-0801'), world.entry('FYP-0802')],
    accounts: ['lora-2', 'lora-3'],
    surface: 'fyp' as const,
    mode: 'gaps' as const,
    week: '2026-W39',
    date: '2026-09-23',
    today: '2026-09-22',
    gaps: GAPS,
    norms: world.norms,
    versions: new Map(),
    ...overrides,
  }
}

describe('раскладка по пустым местам недели (DESIGN §4.12–4.13)', () => {
  it('объект N встаёт на N-е пустое место страницы, по порядку дней, не раньше сегодня', () => {
    const rows = spreadRows(input())
    expect(rows.map((row) => [row.item, row.account, row.date])).toEqual([
      ['FYP-0801', 'lora-2', '2026-09-24'],
      ['FYP-0801', 'lora-3', '2026-09-25'],
      ['FYP-0802', 'lora-2', '2026-09-26'],
      ['FYP-0802', 'lora-3', null],
    ])
  })

  it('места другой недели не берутся: неделя 40 — только её пусто', () => {
    const rows = spreadRows(input({ week: '2026-W40' }))
    expect(rows.map((row) => row.date)).toEqual(['2026-09-30', null, null, null])
  })

  it('«Все на один день» ставит всё на выбранный день со временем нормы', () => {
    const rows = spreadRows(input({ mode: 'day' }))
    expect(rows.every((row) => row.date === '2026-09-23' && row.time === '03:00')).toBe(true)
    expect(rows).toHaveLength(4)
  })

  it('строка без места не ставится, остальные становятся строками плана', () => {
    const rows = spreadRows(input())
    const placed = rows.filter(isPlaced)
    expect(placed).toHaveLength(3)
    const [first] = placed
    if (!first) {
      throw new Error('нет строки')
    }
    expect(spreadToNewRow(first, 'fyp', 'soft')).toMatchObject({
      item_id: 'FYP-0801',
      account: 'lora-2',
      surface: 'fyp',
      date: '2026-09-24',
      time: '03:00',
      awaiting_montage: null,
      marked: null,
    })
  })
})
