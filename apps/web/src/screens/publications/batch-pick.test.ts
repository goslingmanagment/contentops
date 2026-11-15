import { describe, expect, it } from 'vitest'
import { pickAll, pickedItems, togglePick } from './batch-pick'

describe('«Утвердить выбранные»: the version on screen when the box was ticked', () => {
  it('sends the ticked version even after the feed re-read a newer one', () => {
    // Ticked at version 1; an agent changes the draft; the feed now shows version 2.
    const ticked = togglePick(new Map(), { id: 5101, version: 1 })
    const reread = [{ id: 5101, version: 2 }]
    expect(pickedItems(ticked, reread)).toEqual([{ id: 5101, version: 1 }])
  })

  it('«Выбрать все» keeps a tick already made, takes the rest as shown, and sends in the feed order', () => {
    const one = togglePick(new Map(), { id: 2, version: 3 })
    const all = pickAll(one, [
      { id: 1, version: 1 },
      { id: 2, version: 4 },
    ])
    expect(
      pickedItems(all, [
        { id: 1, version: 1 },
        { id: 2, version: 4 },
      ]),
    ).toEqual([
      { id: 1, version: 1 },
      { id: 2, version: 3 },
    ])
    expect(togglePick(all, { id: 1, version: 9 }).has(1)).toBe(false)
  })

  it('a ticked draft no longer shown is still sent: Hub answers for it', () => {
    expect(pickedItems(new Map([[7, 2]]), [])).toEqual([{ id: 7, version: 2 }])
  })
})
