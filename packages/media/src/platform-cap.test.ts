import { describe, expect, it } from 'vitest'
import { DEFAULT_PLATFORM_PROFILE, platformRateKbps } from './copies.ts'

const p = DEFAULT_PLATFORM_PROFILE
/** File size at the ceiling for the whole clip, decimal MB (video + AAC). */
const sizeMb = (durationS: number) =>
  ((platformRateKbps(p, durationS * 1000).maxrateKbps + p.audioKbps) * durationS) / 8000

describe('platform.mp4 size cap (SPEC §9.3: ≤ 480 MB)', () => {
  it('keeps the profile ceiling for short clips and unknown duration', () => {
    for (const ms of [5_500, 139_000, 450_000, 0, Number.NaN]) {
      expect(platformRateKbps(p, ms)).toEqual({ maxrateKbps: 8000, bufsizeKbps: 16000 })
    }
  })

  it('derives the ceiling from the duration past ≈ 7.6 min, buffer in the same ratio', () => {
    expect(platformRateKbps(p, 480_000)).toEqual({ maxrateKbps: 7568, bufsizeKbps: 15136 })
    expect(platformRateKbps(p, 780_000)).toEqual({ maxrateKbps: 4583, bufsizeKbps: 9166 })
    expect(platformRateKbps(p, 1_283_000)).toEqual({ maxrateKbps: 2711, bufsizeKbps: 5422 })
  })

  // 480 MB less the 3 % margin.
  it('fits 480 MB with the margin at every length', () => {
    for (const s of [455, 480, 600, 780, 1283, 3600, 7200]) {
      expect(sizeMb(s)).toBeLessThanOrEqual(465.6)
    }
    expect(sizeMb(1283)).toBeGreaterThan(460)
  })
})
