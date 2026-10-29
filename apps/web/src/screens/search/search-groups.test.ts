import type { CatalogEntry, ItemType } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { GROUP_PREVIEW, searchGroups } from './search-groups'

function entry(id: string, type: ItemType): CatalogEntry {
  return { id, type } as CatalogEntry
}

const everything = (entries: readonly CatalogEntry[]) => [...entries]
const ppv = Array.from({ length: 8 }, (_, index) => entry(`PPV-0${80 + index}`, 'ppv'))
const sets = [entry('SET-001', 'set')]

describe('группы результатов поиска (DESIGN §4.7)', () => {
  it('по ряду из пяти и «ещё N →», типы в порядке разделов', () => {
    const groups = searchGroups([...sets, ...ppv], {
      filter: everything,
      type: undefined,
      oldNumber: null,
    })
    expect(groups.map((group) => [group.kind, group.items.length, group.more])).toEqual([
      ['ppv', GROUP_PREVIEW, 3],
      ['set', 1, 0],
    ])
  })

  it('старый номер у нескольких папок — первой группой, его плитки не повторяются ниже', () => {
    const holders = ppv.slice(0, 3)
    const groups = searchGroups(ppv, {
      filter: everything,
      type: undefined,
      oldNumber: { entries: holders },
    })
    expect(groups[0]?.kind).toBe('old-number')
    expect(groups[0]?.items).toEqual(holders)
    expect(groups[1]).toMatchObject({ kind: 'ppv', total: 5, more: 0 })
  })

  it('чип «Тип» раскрывает свою группу целиком и прячет остальные', () => {
    const groups = searchGroups([...sets, ...ppv], {
      filter: everything,
      type: 'ppv',
      oldNumber: { entries: ppv.slice(0, 3) },
    })
    expect(groups.map((group) => [group.kind, group.items.length, group.more])).toEqual([
      ['ppv', 8, 0],
    ])
  })
})
