import { join } from 'node:path'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { freshDir, toolVersions } from './testing/helpers.ts'
import { runToolChecked, type ToolVersions, toolPaths } from './tools.ts'
import { printDistances, VIDEO_PRINT_PROFILE, videoPrint } from './video-print.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

describe('video print (SPEC §6.2 «Похоже на ролик»)', () => {
  it('another encode with a longer sound track keeps the print; another video does not', async () => {
    const dir = await freshDir('print')
    // As the Я.Диск queue made copies of Ари's montages: the same picture in other bytes, the
    // sound track evened out and 0.4 s longer than the picture.
    const copy = join(dir, 'copy.mp4')
    await runToolChecked(toolPaths().ffmpeg, [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      fx.files.scenes,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=9.4',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'libx264',
      '-crf',
      '30',
      '-c:a',
      'aac',
      copy,
    ])
    const original = await videoPrint({ input: fx.files.scenes, workDir: dir, versions })
    const again = await videoPrint({ input: copy, workDir: dir, versions })
    expect(original.frames).toHaveLength(VIDEO_PRINT_PROFILE.permille.length)
    // The shares are of the picture, not of the container the longer sound track stretched.
    expect(again.durationMs).toBe(original.durationMs)
    expect(Math.max(...printDistances(original.frames, again.frames))).toBeLessThanOrEqual(4)
    const other = await videoPrint({ input: fx.files.vertical, workDir: dir, versions })
    const far = printDistances(original.frames, other.frames).sort((a, b) => a - b)
    expect(far[4]).toBeGreaterThan(9)
  })
})
