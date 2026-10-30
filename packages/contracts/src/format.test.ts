import { describe, expect, it } from 'vitest'
import { formatDate, formatDaysAgo, formatDaysSpan } from './format'

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
