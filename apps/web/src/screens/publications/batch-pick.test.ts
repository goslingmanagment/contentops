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

  it('sends only what the button counts: a tick hidden by another filter stays, and is not sent', () => {
    // Three ticked, the filter changed: one shown, «Утвердить выбранные (1)» approves that one.
    const picks = new Map([
      [1, 1],
      [2, 1],
      [3, 1],
    ])
    expect(pickedItems(picks, [{ id: 2, version: 1 }])).toEqual([{ id: 2, version: 1 }])
    expect(pickedItems(picks, [])).toEqual([])
  })
})
