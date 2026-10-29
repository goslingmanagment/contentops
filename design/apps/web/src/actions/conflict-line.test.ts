import { describe, expect, it } from 'vitest'
import { conflictLine } from './use-versioned-save'

const NOW = '2026-09-22T11:20:00Z'
const details = (changed_by: string, changed_by_gender: 'f' | 'm' | null) => ({
  changed_by,
  changed_by_gender,
  changed_at: '2026-09-22T11:19:00Z',
  field: 'title',
  current_version: 3,
  current_value: null,
})

describe('строка конфликта версии', () => {
  it('род глагола и «её/его» — из ответа сервера, а не по имени', () => {
    expect(conflictLine(details('Никита', 'm'), 'название', NOW)).toEqual({
      message: 'Никита изменил название 1 мин назад',
      theirsLabel: 'Показать его вариант',
    })
    expect(conflictLine(details('Диана', 'f'), 'теги', NOW)).toEqual({
      message: 'Диана изменила теги 1 мин назад',
      theirsLabel: 'Показать её вариант',
    })
    // Имя на «а», но сервер говорит «мужской»: имени не верим.
    expect(conflictLine(details('Савва', 'm'), 'описание', NOW).message).toBe(
      'Савва изменил описание 1 мин назад',
    )
  })

  it('без рода — нейтральная кнопка', () => {
    expect(conflictLine(details('агент приёмки', null), 'название', NOW).theirsLabel).toBe(
      'Показать другой вариант',
    )
  })
})
