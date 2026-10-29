import { describe, expect, it } from 'vitest'
import { createFrozenClock, PROTOTYPE_NOW } from '../../clock'
import type { NewPlanRow } from '../../commands/plan'
import { formatDate, formatDaysAgo, formatDaysSpan } from '../../format'
import { createApiClient } from '../client'
import { createMockFetch } from './mock-fetch'

const lora = { model: 'lora' }

function setup() {
  return createApiClient(
    createMockFetch({ latency: false, clock: createFrozenClock(PROTOTYPE_NOW), operation_ms: 0 }),
  )
}

function candidate(patch: Partial<NewPlanRow>): NewPlanRow {
  return {
    item_id: 'SET-074',
    account: 'lora-1',
    surface: 'wall',
    date: '2026-09-22',
    time: '20:00',
    fyp_version: null,
    assignee: null,
    note: null,
    requires_new_upload: false,
    awaiting_montage: null,
    marked: null,
    ...patch,
  }
}

async function check(patch: Partial<NewPlanRow>) {
  return setup().plan.checkRow({ params: lora, body: candidate(patch) })
}

describe('строка проверки «В план» (DESIGN §4.13)', () => {
  it('SET-074 уже в планировщике на Fansly 1 во вт 22 — «уже в плане» первым, в тот же день', async () => {
    const result = await check({})
    expect(result.warnings[0]?.kind).toBe('already_planned')
    expect(result.tone).toBe('attention')
    expect(result.text).toBe('Уже в плане: Fansly 1 · вт 22.09, 20:00 · в планировщике')
  })

  it('«уже в плане» и тогда, когда строка стоит раньше выбранного дня', async () => {
    const result = await check({ date: '2026-09-26' })
    expect(result.warnings[0]).toMatchObject({ kind: 'already_planned', date: '2026-09-22' })
  })

  it('выпуск PPV-076 в чт 24 виден из сб 26 и из вт 22', async () => {
    for (const date of ['2026-09-22', '2026-09-26']) {
      const result = await check({ item_id: 'PPV-076', account: 'lora-2', date })
      expect(result.warnings[0]).toMatchObject({ kind: 'already_planned', date: '2026-09-24' })
    }
  })

  it('другое место той же страницы — не повтор: PPV-076 в vault', async () => {
    const result = await check({ item_id: 'PPV-076', account: 'lora-2', surface: 'vault' })
    expect(result.warnings.map((warning) => warning.kind)).not.toContain('already_planned')
  })

  it('сырьё: RAW-0214 уже ждёт монтаж на Fansly 1 — повтор виден и у строки под монтаж', async () => {
    const result = await check({
      item_id: null,
      surface: 'fyp',
      time: '03:00',
      awaiting_montage: { from_item: 'RAW-0214', expected_type: 'fyp', file_keys: ['raw03'] },
    })
    expect(result.warnings[0]?.kind).toBe('already_planned')
    expect(result.text).toBe('Уже в плане: Fansly 1 · вт 22.09, весь день · ждёт монтаж')
  })

  it('отменённая строка не держит место: PPV-071 в сториз Fansly 2', async () => {
    const result = await check({ item_id: 'PPV-071', account: 'lora-2', surface: 'story' })
    expect(result.warnings.map((warning) => warning.kind)).not.toContain('already_planned')
  })

  it('два поста в одно время — полной фразой со страницей и объектом', async () => {
    const result = await check({ item_id: 'SET-073', account: 'lora-1' })
    expect(result.text).toBe('В 20:00 на Fansly 1 уже стоит SET-074 — два поста в одно время')
  })

  it('без повтора дни считаются к выбранному дню и так и подписаны', async () => {
    const today = await check({ item_id: 'FYP-0801', surface: 'fyp', time: '03:00' })
    expect(today.text).toMatch(/^Повторов нет · на Fansly 1 было 12\.08 — 41 день назад$/)
    const later = await check({
      item_id: 'FYP-0801',
      surface: 'fyp',
      time: '03:00',
      date: '2026-09-26',
    })
    expect(later.text).toBe('Повторов нет · на Fansly 1 было 12.08, к сб 26 будет 45 дней')
  })

  it('сегодня уже вышло на этой странице — «слишком рано», а не «повторов нет»', async () => {
    const result = await check({
      item_id: 'FYP-0801',
      account: 'lora-3',
      surface: 'fyp',
      date: '2026-09-23',
      time: '03:00',
    })
    expect(result.warnings[0]?.kind).toBe('too_early')
    expect(result.text).toBe('Слишком рано: на Fansly 3 было 22.09, к ср 23 будет 1 день')
  })

  it('предпросмотр пакета несёт «уже в плане», а строки плана — только янтарь строки', async () => {
    const api = setup()
    const preview = await api.plan.createRows({
      params: lora,
      query: { dry_run: true },
      body: { rows: [candidate({ date: '2026-09-26' })] },
    })
    expect(preview.rows[0]?.warnings[0]?.kind).toBe('already_planned')
    const day = await api.plan.day({ params: lora, query: { date: '2026-09-22' } })
    const kinds = day.rows.flatMap((row) => row.warnings.map((warning) => warning.kind))
    expect(kinds.every((kind) => kind === 'too_early' || kind === 'same_time')).toBe(true)
  })
})

describe('даты и промежутки словами', () => {
  it('год пишется только у другого года', () => {
    expect(formatDate('2026-08-12', '2026-09-22')).toBe('12.08')
    expect(formatDate('2025-09-22', '2026-09-22')).toBe('22.09.2025')
  })

  it('словоформы и длинные промежутки', () => {
    expect(formatDaysSpan(1)).toBe('1 день')
    expect(formatDaysSpan(41)).toBe('41 день')
    expect(formatDaysSpan(45)).toBe('45 дней')
    expect(formatDaysSpan(92)).toBe('3 месяца')
    expect(formatDaysAgo(0)).toBe('сегодня')
    expect(formatDaysAgo(1)).toBe('вчера')
    expect(formatDaysAgo(3)).toBe('3 дня назад')
    expect(formatDaysAgo(361)).toBe('год назад')
    expect(formatDaysAgo(365)).toBe('год назад')
    expect(formatDaysAgo(556)).toBe('полтора года назад')
    expect(formatDaysAgo(800)).toBe('2 года назад')
  })
})
