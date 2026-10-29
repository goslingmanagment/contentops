import { describe, expect, it } from 'vitest'
import { clampIndex, selectOnly, selectRange, toggleKey } from './selection'

const keys = ['a', 'b', 'c', 'd', 'e']

describe('выделение', () => {
  it('клик выбирает один, вне списка — ничего', () => {
    expect([...selectOnly(keys, 2)]).toEqual(['c'])
    expect(selectOnly(keys, 9).size).toBe(0)
  })

  it('Ctrl/⌘ добавляет и убирает один ключ, не трогая остальные', () => {
    const selected = new Set(['a', 'c'])
    expect([...toggleKey(selected, 'b')].sort()).toEqual(['a', 'b', 'c'])
    expect([...toggleKey(selected, 'c')]).toEqual(['a'])
    expect([...toggleKey(selected, undefined)].sort()).toEqual(['a', 'c'])
    expect([...selected].sort()).toEqual(['a', 'c'])
  })

  it('Shift — диапазон в любую сторону, с прежним выделением по желанию', () => {
    expect([...selectRange(keys, 1, 3)]).toEqual(['b', 'c', 'd'])
    expect([...selectRange(keys, 3, 1)]).toEqual(['b', 'c', 'd'])
    expect([...selectRange(keys, 3, 4, new Set(['a']))].sort()).toEqual(['a', 'd', 'e'])
  })

  it('номер держится в пределах списка', () => {
    expect(clampIndex(-1, 5)).toBe(0)
    expect(clampIndex(7, 5)).toBe(4)
    expect(clampIndex(3, 0)).toBe(0)
  })
})
