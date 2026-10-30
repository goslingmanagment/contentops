import { describe, expect, it } from 'vitest'
import { platformSize, UNIQ_MAX_VERSIONS, uniqFilters, uniqParams } from './copies.ts'

describe('uniq versions (SPEC §9.3)', () => {
  it('follows the table of the norm for n = 1 and n = 2', () => {
    expect(uniqParams('soft', 1)).toEqual({
      level: 'soft',
      n: 1,
      zoomPct: 1,
      speedPct: 1,
      trimEndSec: 0,
      mirror: false,
    })
    expect(uniqParams('soft', 2)).toMatchObject({ zoomPct: 2, speedPct: -1 })
  })

  it('adds the end cut for «подрезка» and the flip for «зеркало»', () => {
    expect(uniqParams('trim', 1)).toMatchObject({
      zoomPct: 1,
      speedPct: 1,
      trimEndSec: 0.3,
      mirror: false,
    })
    expect(uniqParams('trim', 3).trimEndSec).toBe(0.5)
    expect(uniqParams('mirror', 2)).toMatchObject({
      zoomPct: 2,
      speedPct: -1,
      trimEndSec: 0,
      mirror: true,
    })
  })

  it('is deterministic and gives pairwise different versions', () => {
    const seen = new Set<string>()
    for (let n = 1; n <= UNIQ_MAX_VERSIONS; n++) {
      const a = uniqParams('soft', n)
      expect(uniqParams('soft', n)).toEqual(a)
      expect(a.zoomPct).toBeGreaterThanOrEqual(1)
      expect(a.zoomPct).toBeLessThanOrEqual(2)
      expect(Math.abs(a.speedPct)).toBe(1)
      seen.add(`${a.zoomPct}/${a.speedPct}`)
    }
    expect(seen.size).toBe(UNIQ_MAX_VERSIONS)
    expect(() => uniqParams('soft', 0)).toThrow(RangeError)
    expect(() => uniqParams('soft', UNIQ_MAX_VERSIONS + 1)).toThrow(RangeError)
  })

  it('builds crop/scale to even profile sizes, setpts and atempo', () => {
    const size = platformSize(2160, 3840, 1920)
    expect(size).toEqual({ width: 1080, height: 1920 })
    const f = uniqFilters(uniqParams('mirror', 2), size, 30, false)
    expect(f.video).toBe(
      'crop=w=trunc(iw*0.98/2)*2:h=trunc(ih*0.98/2)*2:x=(iw-ow)/2:y=(ih-oh)/2,scale=1080:1920,hflip,setpts=PTS/0.99,fps=30,format=yuv420p',
    )
    expect(f.audio).toBe('atempo=0.99')
    expect(platformSize(320, 181, 1920)).toEqual({ width: 320, height: 180 })
  })
})
