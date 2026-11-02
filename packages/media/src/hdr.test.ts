import { describe, expect, it } from 'vitest'
import { filterPath, hdrSignalOf, hlgSdrCube, hlgToSdr } from './hdr.ts'

describe('HDR signal of a source (SPEC §9.3)', () => {
  it('HLG by its transfer, PQ by its transfer or by no tag, anything else is an SDR base', () => {
    expect(hdrSignalOf({ colorTransfer: 'arib-std-b67' })).toBe('hlg')
    expect(hdrSignalOf({ colorTransfer: 'smpte2084' })).toBe('pq')
    expect(hdrSignalOf({ colorTransfer: 'unknown' })).toBe('pq')
    expect(hdrSignalOf({ colorTransfer: null })).toBe('pq')
    expect(hdrSignalOf({ colorTransfer: 'bt709' })).toBe('sdr')
  })
})

describe('HLG table', () => {
  const rows = hlgSdrCube().trim().split('\n')

  it('is a 17-point .cube from black to white', () => {
    expect(rows[0]).toBe('LUT_3D_SIZE 17')
    expect(rows).toHaveLength(17 ** 3 + 1)
    expect(rows[1]).toBe('0.00000 0.00000 0.00000')
    expect(rows.at(-1)).toBe('1.00000 1.00000 1.00000')
  })

  it('keeps the neutral axis neutral and rising', () => {
    let previous = -1
    for (let i = 0; i < 17; i++) {
      const [r, g, b] = (rows[1 + i * (1 + 17 + 17 * 17)] as string).split(' ').map(Number) as [
        number,
        number,
        number,
      ]
      expect(Math.abs(r - g)).toBeLessThan(0.002)
      expect(Math.abs(b - g)).toBeLessThan(0.002)
      expect(g).toBeGreaterThan(previous)
      previous = g
    }
  })
})

describe('a path in a filter graph', () => {
  it('escapes both levels of FFmpeg parsing', () => {
    expect(filterPath('/srv/tmp/a.cube')).toBe('/srv/tmp/a.cube')
    expect(filterPath('/a:b')).toBe('/a\\\\:b')
    expect(filterPath("/a'b")).toBe("/a\\\\\\'b")
    expect(filterPath('/a,b[c];d')).toBe('/a\\,b\\[c\\]\\;d')
    expect(hlgToSdr('/x.cube')).toContain('lut3d=file=/x.cube:interp=tetrahedral')
  })
})
