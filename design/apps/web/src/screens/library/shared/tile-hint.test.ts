import { type Account, formatNumber, type PageSummaryEntry } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { tileHintText, tileHintTitle } from './tile-hint'

const fansly2: Account = {
  code: 'lora-2',
  model: 'lora',
  platform: 'fansly',
  label: 'Fansly 2',
  handle: 'LoraViex',
  hub_page: 'lora-2',
  usual_assignee: null,
  uniq_level: 'soft',
  position: 1,
}

const TODAY = '2026-09-22'

function summary(patch: Partial<PageSummaryEntry>): PageSummaryEntry {
  return {
    item_id: 'PPV-073',
    account: 'lora-2',
    level: 'unknown',
    sign: null,
    word: 'не видели',
    detail: null,
    last_on: null,
    has_turn: false,
    has_trouble: false,
    placed_on: [],
    planned_on: [],
    has_fyp_version: false,
    views: null,
    likes: null,
    stats_on: null,
    ...patch,
  }
}

describe('ответ под плиткой (DESIGN §4.2)', () => {
  it('короткий: страница уже названа в чипе или сортировке', () => {
    const page = { kind: 'page', account: fansly2, today: TODAY } as const
    expect(tileHintText(page, undefined)).toBe('не видели')
    expect(
      tileHintText(page, [
        summary({ placed_on: ['vault'], last_on: '2026-08-08', word: 'подтверждено' }),
      ]),
    ).toBe('Fansly 2 08.08')
  })

  it('дата другого года — с годом; на плитке страница уступает дате, в подсказке — целиком', () => {
    const page = { kind: 'page', account: fansly2, today: TODAY } as const
    const placed = [summary({ placed_on: ['wall'], last_on: '2025-09-22', word: 'подтверждено' })]
    expect(tileHintText(page, placed)).toBe('22.09.2025')
    expect(tileHintText(page, placed, true)).toBe('22.09.2025')
    expect(tileHintTitle(page, placed)).toBe('Fansly 2 22.09.2025')
  })

  it('«Лучше зашёл на ▾» — число просмотров', () => {
    const views = { kind: 'views', account: fansly2, today: TODAY } as const
    expect(tileHintText(views, [summary({ views: 12480 })])).toBe(formatNumber(12480))
    expect(tileHintText(views, undefined)).toBe('нет просмотров')
  })
})

describe('ответ на малой плитке 120 (DESIGN §4.2)', () => {
  const page = { kind: 'page', account: fansly2, today: TODAY } as const
  it('коротко: дата или «нет», полный ответ со страницей — в подсказке', () => {
    const placed = [summary({ placed_on: ['vault'], last_on: '2026-08-08', word: 'подтверждено' })]
    expect(tileHintText(page, placed, true)).toBe('08.08')
    expect(tileHintTitle(page, placed)).toBe('Fansly 2 08.08')
    expect(tileHintText(page, undefined, true)).toBe('нет')
    expect(tileHintTitle(page, undefined)).toBe('не видели на Fansly 2')
  })

  it('среди незалитого видно, что уже в плане; полное слово — в подсказке', () => {
    const planned = [summary({ level: 'planned', word: 'в плане', planned_on: ['vault'] })]
    expect(tileHintText(page, planned, true)).toBe('план')
    expect(tileHintTitle(page, planned)).toBe('в плане на Fansly 2')
    const scheduled = [summary({ level: 'scheduled', word: 'в планировщике' })]
    expect(tileHintText(page, scheduled, true)).toBe('план')
    expect(tileHintTitle(page, scheduled)).toBe('в планировщике на Fansly 2')
    const missed = [
      summary({ level: 'missed', sign: 'trouble', word: 'пропущено', planned_on: ['vault'] }),
    ]
    expect(tileHintText(page, missed, true)).toBe('нет')
    expect(tileHintTitle(page, missed)).toBe('пропущено на Fansly 2')
  })

  it('просмотры — число, подсказка со страницей', () => {
    const views = { kind: 'views', account: fansly2, today: TODAY } as const
    expect(tileHintText(views, [summary({ views: 12480 })], true)).toBe(formatNumber(12480))
    expect(tileHintTitle(views, [summary({ views: 12480 })])).toBe(
      `${formatNumber(12480)} просмотров на Fansly 2`,
    )
    expect(tileHintText(views, undefined, true)).toBe('нет')
  })
})
