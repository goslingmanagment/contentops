import { describe, expect, it } from 'vitest'
import { clickSelection, keyMove, moveModeOf, nearestSelectable } from './collection-moves'

const keys = ['h1', 'a', 'b', 'h2', 'c', 'd']
/** Заголовки групп — не элементы: на них не встают. */
const isItem = (index: number) => !keys[index]?.startsWith('h')
const byRows = (columns: number) => (index: number, direction: 1 | -1) =>
  index + direction * columns

describe('клавиши в сетке', () => {
  it('стрелки идут по плиткам и рядам, Home и End — в края', () => {
    expect(keyMove('ArrowRight', 2, 6, byRows(3))).toEqual([3, 1])
    expect(keyMove('ArrowLeft', 2, 6, byRows(3))).toEqual([1, -1])
    expect(keyMove('ArrowDown', 1, 6, byRows(3))).toEqual([4, 1])
    expect(keyMove('ArrowUp', 4, 6, byRows(3))).toEqual([1, -1])
    expect(keyMove('Home', 4, 6, byRows(3))).toEqual([0, 1])
    expect(keyMove('End', 1, 6, byRows(3))).toEqual([5, -1])
    expect(keyMove('KeyQ', 1, 6, byRows(3))).toBeUndefined()
  })

  it('заголовок группы пропускается в сторону движения; за краем — остаёмся', () => {
    expect(nearestSelectable(3, 1, 6, isItem, 2)).toBe(4)
    expect(nearestSelectable(3, -1, 6, isItem, 4)).toBe(2)
    expect(nearestSelectable(0, -1, 6, isItem, 1)).toBe(1)
    expect(nearestSelectable(9, 1, 6, isItem, 1)).toBe(5)
  })

  it('Shift расширяет, Ctrl/⌘ ведёт только фокус', () => {
    expect(moveModeOf(false, false)).toBe('select')
    expect(moveModeOf(true, false)).toBe('extend')
    expect(moveModeOf(true, true)).toBe('extend')
    expect(moveModeOf(false, true)).toBe('focus')
  })
})

describe('щелчок', () => {
  const base = { keys, selected: new Set(['a']), anchor: 1 }

  it('простой — один элемент и новая опора', () => {
    const result = clickSelection({ ...base, index: 4, shiftKey: false, modifier: false })
    expect([...result.selected]).toEqual(['c'])
    expect(result.anchor).toBe(4)
  })

  it('Shift — диапазон от опоры, опора на месте; с Ctrl/⌘ — к прежнему', () => {
    const range = clickSelection({ ...base, index: 2, shiftKey: true, modifier: false })
    expect([...range.selected]).toEqual(['a', 'b'])
    expect(range.anchor).toBe(1)
    const kept = clickSelection({
      ...base,
      selected: new Set(['d']),
      index: 2,
      shiftKey: true,
      modifier: true,
    })
    expect([...kept.selected].sort()).toEqual(['a', 'b', 'd'])
  })

  it('Ctrl/⌘ — точечно, опора переезжает', () => {
    const result = clickSelection({ ...base, index: 5, shiftKey: false, modifier: true })
    expect([...result.selected].sort()).toEqual(['a', 'd'])
    expect(result.anchor).toBe(5)
  })
})
