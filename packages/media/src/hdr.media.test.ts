import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import {
  buildCompatibleCopy,
  buildPlatformCopy,
  buildUniqVersion,
  DEFAULT_PLATFORM_PROFILE,
  platformRecipe,
} from './copies.ts'
import { HDR_TO_SDR } from './derive-video.ts'
import { extractFrame, frameRecipe } from './frame.ts'
import { probeVideo } from './probe.ts'
import { HDR_PATCH_COLUMNS, HDR_PATCH_SIDE, HDR_PATCHES } from './testing/fixtures.ts'
import { freshDir, listFiles, toolVersions } from './testing/helpers.ts'
import { runToolChecked, type ToolVersions, toolPaths } from './tools.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

type PatchName = (typeof HDR_PATCHES)[number]['name']
type Lab = readonly [L: number, a: number, b: number]

const SKIN = ['lightSkin', 'darkSkin', 'brightSkin'] as const
const NEUTRAL = ['grey', 'lightGrey', 'white'] as const

/**
 * The patches of the fixtures after `avconvert -p PresetHighestQuality` on a Mac, 02.11.2026:
 * what a person compares a copy with (compression.md §10.12).
 */
const APPLE_HLG: Record<PatchName, Lab> = {
  lightSkin: [42.32, 9.11, 12.98],
  darkSkin: [24.61, 9.14, 11.21],
  brightSkin: [52.65, 8.4, 12.9],
  grey: [33.6, 0, 0],
  lightGrey: [51.62, 0, 0],
  white: [60.56, 0, 0],
}
const APPLE_PQ: Pick<Record<PatchName, Lab>, 'lightSkin' | 'darkSkin'> = {
  lightSkin: [61.5, 15.31, 17.17],
  darkSkin: [33.77, 10.19, 13.84],
}

function labOf(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const [fx, fy, fz] = [
    (0.4124564 * lr + 0.3575761 * lg + 0.180437 * lb) / 0.95047,
    0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb,
    (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883,
  ].map((t) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29)) as [
    number,
    number,
    number,
  ]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const deltaE = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const chroma = (p: Lab) => Math.hypot(p[1], p[2])
const hue = (p: Lab) => (Math.atan2(p[2], p[1]) * 180) / Math.PI

/** CIE Lab of every patch of a picture, as BT.709 limited range looks on an sRGB screen. */
async function patches(file: string, filter = ''): Promise<Record<PatchName, Lab>> {
  const png = join(await freshDir('patches'), 'frame.png')
  await runToolChecked(toolPaths().ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-vf',
    `${filter}scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24`,
    '-frames:v',
    '1',
    png,
  ])
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const out = {} as Record<PatchName, Lab>
  for (const [index, { name }] of HDR_PATCHES.entries()) {
    const left = (index % HDR_PATCH_COLUMNS) * HDR_PATCH_SIDE
    const top = Math.floor(index / HDR_PATCH_COLUMNS) * HDR_PATCH_SIDE
    const sum = [0, 0, 0]
    let n = 0
    for (let y = top + 30; y < top + HDR_PATCH_SIDE - 30; y++) {
      for (let x = left + 30; x < left + HDR_PATCH_SIDE - 30; x++) {
        const at = (y * info.width + x) * info.channels
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] as number) + (data[at + c] as number)
        n++
      }
    }
    out[name] = labOf((sum[0] as number) / n, (sum[1] as number) / n, (sum[2] as number) / n)
  }
  return out
}

const SDR_COPY = {
  codec: 'h264',
  pixFmt: 'yuv420p',
  colorTransfer: 'bt709',
  colorPrimaries: 'bt709',
  colorSpace: 'bt709',
  isHdr: false,
}

describe('copies from HDR sources (SPEC §9.3, compression.md §10.12)', () => {
  it('HLG: skin as in Apple’s conversion, greys neutral; the old recipe runs orange', async () => {
    const outDir = await freshDir('hlg')
    const { file, recipe } = await buildPlatformCopy({
      input: fx.files.hlgPatches,
      outDir,
      versions,
    })
    expect((await probeVideo(file.path)).video).toMatchObject(SDR_COPY)
    expect(await listFiles(outDir)).toEqual(['platform.mp4'])
    expect(recipe.digest).toBe(
      platformRecipe(versions, DEFAULT_PLATFORM_PROFILE, false, true).digest,
    )
    const copy = await patches(file.path)
    for (const name of SKIN) {
      const apple = APPLE_HLG[name]
      expect(deltaE(copy[name], apple), name).toBeLessThan(2)
      expect(Math.abs(chroma(copy[name]) - chroma(apple)), name).toBeLessThan(1)
      expect(Math.abs(hue(copy[name]) - hue(apple)), name).toBeLessThan(4)
    }
    // The old recipe on the same patches: skin lighter and more saturated (measured ΔE 6–12).
    const old = await patches(fx.files.hlgPatches, `${HDR_TO_SDR},`)
    const mean = (f: (name: (typeof SKIN)[number]) => number) =>
      SKIN.reduce((sum, name) => sum + f(name), 0) / SKIN.length
    expect(mean((name) => deltaE(old[name], APPLE_HLG[name]))).toBeGreaterThan(7)
    expect(mean((name) => chroma(old[name]) - chroma(APPLE_HLG[name]))).toBeGreaterThan(2)
    for (const name of NEUTRAL) {
      expect(Math.abs(copy[name][0] - APPLE_HLG[name][0]), name).toBeLessThan(1)
      expect(chroma(copy[name]), name).toBeLessThan(0.5)
    }
  })

  it('uniq versions and the compatible copy convert the same way', async () => {
    const platform = await patches(
      (
        await buildPlatformCopy({
          input: fx.files.hlgPatches,
          outDir: await freshDir('p'),
          versions,
        })
      ).file.path,
    )
    const uniq = await buildUniqVersion({
      input: fx.files.hlgPatches,
      outDir: await freshDir('u'),
      level: 'soft',
      n: 1,
      versions,
    })
    const compatible = await buildCompatibleCopy({
      input: fx.files.hlgPatches,
      outDir: await freshDir('c'),
      versions,
    })
    for (const built of [uniq, compatible]) {
      expect((await probeVideo(built.file.path)).video).toMatchObject(SDR_COPY)
      const seen = await patches(built.file.path)
      for (const { name } of HDR_PATCHES) {
        expect(deltaE(seen[name], platform[name]), name).toBeLessThan(1.5)
      }
    }
  })

  it('PQ: builds with a cheap chain near Apple’s PQ conversion, greys neutral', async () => {
    const outDir = await freshDir('pq')
    const { file } = await buildPlatformCopy({ input: fx.files.pqPatches, outDir, versions })
    expect((await probeVideo(file.path)).video).toMatchObject(SDR_COPY)
    expect(await listFiles(outDir)).toEqual(['platform.mp4'])
    const copy = await patches(file.path)
    expect(deltaE(copy.lightSkin, APPLE_PQ.lightSkin)).toBeLessThan(3)
    expect(deltaE(copy.darkSkin, APPLE_PQ.darkSkin)).toBeLessThan(3)
    for (const name of NEUTRAL) expect(chroma(copy[name]), name).toBeLessThan(0.5)
  })

  it('takes an output folder with characters special to a filter graph', async () => {
    const outDir = join(await freshDir('path'), "it's, [a]:b;c")
    await mkdir(outDir)
    const { file } = await buildPlatformCopy({ input: fx.files.hlgPatches, outDir, versions })
    expect((await probeVideo(file.path)).video).toMatchObject(SDR_COPY)
    expect(await listFiles(outDir)).toEqual(['platform.mp4'])
  })

  it('a frame taken as a photo converts the same way', async () => {
    const outDir = await freshDir('frame')
    const frame = await extractFrame({ input: fx.files.hlgPatches, outDir, atMs: 0, versions })
    expect(frame.recipe.digest).toBe(frameRecipe(versions, true).digest)
    expect(await listFiles(outDir)).toEqual([frame.file.name])
    const seen = await patches(frame.file.path, 'scale=out_color_matrix=bt709:out_range=tv,')
    for (const name of SKIN) expect(deltaE(seen[name], APPLE_HLG[name]), name).toBeLessThan(2)
  })

  it('an SDR source keeps its recipe and needs no table', async () => {
    const outDir = await freshDir('sdr')
    const { recipe } = await buildPlatformCopy({ input: fx.files.lowrate, outDir, versions })
    expect(recipe.digest).toBe(platformRecipe(versions, DEFAULT_PLATFORM_PROFILE, false).digest)
    expect(recipe.recipe.profile).toMatchObject({ hdr: HDR_TO_SDR })
    expect(await listFiles(outDir)).toEqual(['platform.mp4'])
  })
})
