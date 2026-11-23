import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { belowStop, type HostSpace, PILOT_SPACE, readHostSpace, SPACE_STALE_MS } from './space'

const NOW = new Date('2026-11-23T12:00:00Z')
const GB = 1_000_000_000

const freshSpace = (cGb: number, eGb = 250): HostSpace => ({
  measured_at: new Date(NOW.getTime() - 60_000).toISOString(),
  disks: [
    { name: 'C:', free_bytes: cGb * GB, total_bytes: 2000 * GB },
    { name: 'E:', free_bytes: eGb * GB, total_bytes: 500 * GB },
  ],
})

describe('belowStop (SPEC §12.2 fail-closed)', () => {
  it('returns true (fail-closed) when HOST_SPACE_FILE is configured and space is null or stale', () => {
    const opts = { file: '/host/space.json', ...PILOT_SPACE }
    expect(belowStop(null, opts, NOW)).toBe(true)

    const stale: HostSpace = {
      ...freshSpace(500, 300),
      measured_at: new Date(NOW.getTime() - SPACE_STALE_MS - 1_000).toISOString(),
    }
    expect(belowStop(stale, opts, NOW)).toBe(true)
  })

  it('returns false when HOST_SPACE_FILE is unset and space is null or stale', () => {
    const opts = { file: undefined, ...PILOT_SPACE }
    expect(belowStop(null, opts, NOW)).toBe(false)
    const stale: HostSpace = {
      ...freshSpace(50, 50),
      measured_at: new Date(NOW.getTime() - SPACE_STALE_MS - 1_000).toISOString(),
    }
    expect(belowStop(stale, opts, NOW)).toBe(false)
  })

  it('checks fresh reports against per-disk stop thresholds', () => {
    const opts = { file: '/host/space.json', ...PILOT_SPACE }
    expect(belowStop(freshSpace(150, 200), opts, NOW)).toBe(false)
    expect(belowStop(freshSpace(100, 200), opts, NOW)).toBe(true)
    expect(belowStop(freshSpace(300, 99), opts, NOW)).toBe(true)
  })

  it('readHostSpace returns null for missing or malformed files and parses valid JSON with BOM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'contentops-space-'))
    try {
      expect(await readHostSpace(join(dir, 'missing.json'))).toBeNull()
      const bad = join(dir, 'bad.json')
      await writeFile(bad, '{broken')
      expect(await readHostSpace(bad)).toBeNull()
      const ok = join(dir, 'ok.json')
      await writeFile(ok, `\uFEFF${JSON.stringify(freshSpace(180, 220))}`)
      const parsed = await readHostSpace(ok)
      expect(parsed?.disks).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
