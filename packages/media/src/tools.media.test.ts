import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { toolVersions } from './testing/helpers.ts'
import { MediaAbortError, PINNED_TOOLS, progressParser, runTool, toolPaths } from './tools.ts'

const strict = process.env.CONTENTOPS_MEDIA_STRICT === '1'

describe('tools', () => {
  it('reports versions; the image carries the pinned ones', async () => {
    const v = await toolVersions()
    expect(v.ffmpeg).toBeTruthy()
    expect(v.svtav1).toMatch(/^v\d/)
    expect(sharp.format.heif.input.file).toBe(true)
    if (strict) {
      expect(v.ffmpeg.startsWith(PINNED_TOOLS.ffmpegPrefix)).toBe(true)
      expect(v.ffprobe.startsWith(PINNED_TOOLS.ffmpegPrefix)).toBe(true)
      expect(v.svtav1).toBe(PINNED_TOOLS.svtav1)
      expect(v.libvips).toBe(PINNED_TOOLS.libvips)
      expect(v.sharp).toBe(PINNED_TOOLS.sharp)
      expect(v.libheif).toBeTruthy()
      expect(v.libde265).toBeTruthy()
    }
  })

  it('abort kills the process group', async () => {
    const controller = new AbortController()
    let pid = 0
    const run = runTool(
      toolPaths().ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=1280x720:d=600',
        '-f',
        'null',
        '-',
      ],
      {
        signal: controller.signal,
        onSpawn: (p) => {
          pid = p
        },
      },
    )
    setTimeout(() => controller.abort(), 300)
    await expect(run).rejects.toBeInstanceOf(MediaAbortError)
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('runs below the default priority when asked', async () => {
    const plain = await runTool('nice', [], { captureStdout: true })
    const lowered = await runTool('nice', [], { captureStdout: true, niceness: 7 })
    expect(Number(lowered.stdout) - Number(plain.stdout)).toBe(7)
  })

  it('reports progress to the end', async () => {
    const seen: (number | null)[] = []
    const r = await runTool(
      toolPaths().ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-progress',
        'pipe:1',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:d=2',
        '-f',
        'null',
        '-',
      ],
      { onStdoutLine: progressParser(2000, (p) => seen.push(p.fraction)) },
    )
    expect(r.code).toBe(0)
    expect(seen.at(-1)).toBe(1)
  })
})
