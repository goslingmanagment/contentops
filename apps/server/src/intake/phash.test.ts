import { describe, expect, it } from 'vitest'
import { phashMaxDistance } from './phash'

/** «Похожесть кадров» is a percent on the screen; the hints compare a distance of 64 bits. */
describe('phashMaxDistance', () => {
  it('turns the percent of the screen into the largest distance in bits', () => {
    expect(phashMaxDistance(90)).toBe(6)
    expect(phashMaxDistance(92)).toBe(5)
    expect(phashMaxDistance(75)).toBe(16)
    expect(phashMaxDistance(100)).toBe(0)
    expect(phashMaxDistance(0)).toBe(64)
  })

  it('gives no hints outside 0–100', () => {
    expect(phashMaxDistance(-1)).toBe(null)
    expect(phashMaxDistance(101)).toBe(null)
    expect(phashMaxDistance(Number.NaN)).toBe(null)
  })
})
