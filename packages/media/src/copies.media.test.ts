import { readFile } from 'node:fs/promises'
import exifr from 'exifr'
import sharp from 'sharp'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import {
  buildCompatibleCopy,
  buildPlatformCopy,
  buildUniqVersion,
  DEFAULT_PLATFORM_PROFILE,
  stripPhotoMetadata,
  stripVideoMetadata,
} from './copies.ts'
import { probeVideo } from './probe.ts'
import { freshDir, toolVersions } from './testing/helpers.ts'
import { runToolChecked, type ToolVersions, toolPaths } from './tools.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

async function streamHashes(file: string, map: string): Promise<string> {
  const { stdout } = await runToolChecked(
    toolPaths().ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-map',
      map,
      '-c',
      'copy',
      '-f',
      'streamhash',
      '-hash',
      'sha256',
      '-',
    ],
    { captureStdout: true },
  )
  return stdout.replace(/^\d+,/gm, '')
}

/** First frame as raw RGB, optionally mirrored back. */
async function firstFrame(file: string, flop = false): Promise<Buffer> {
  const png = `${file}.png`
  await runToolChecked(toolPaths().ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-frames:v',
    '1',
    png,
  ])
  const image = sharp(png)
  return (flop ? image.flop() : image).raw().toBuffer()
}

describe('platform copy (SPEC §9.3)', () => {
  it('4K60 HDR → 1080p60 SDR H.264 with AAC', async () => {
    const { file, recipe } = await buildPlatformCopy({
      input: fx.files.hdr4k60,
      outDir: await freshDir('pf'),
      versions,
    })
    expect(file).toMatchObject({
      kind: 'platform',
      name: 'platform.mp4',
      width: 1920,
      height: 1080,
    })
    const p = await probeVideo(file.path)
    expect(p.video).toMatchObject({ codec: 'h264', colorTransfer: 'bt709', isHdr: false })
    expect(p.video.fpsNum / p.video.fpsDen).toBe(60)
    expect(p.audio.map((a) => a.codec)).toEqual(['aac'])
    expect(recipe.recipe.profile).toMatchObject({
      id: DEFAULT_PLATFORM_PROFILE.id,
      metaStripped: false,
    })
  })

  it('no upscaling; metadata kept or stripped by the switch', async () => {
    const kept = await buildPlatformCopy({
      input: fx.files.vfr120,
      outDir: await freshDir('pf-kept'),
      versions,
    })
    expect([kept.file.width, kept.file.height]).toEqual([320, 180])
    expect((await probeVideo(kept.file.path)).tags['com.apple.quicktime.make']).toBeDefined()
    const stripped = await buildPlatformCopy({
      input: fx.files.vfr120,
      outDir: await freshDir('pf-strip'),
      metaStripped: true,
      versions,
    })
    const tags = Object.keys((await probeVideo(stripped.file.path)).tags)
    expect(
      tags.filter((t) => t.startsWith('com.apple') || t === 'creation_time' || t === 'encoder'),
    ).toEqual([])
    expect(stripped.recipe.digest).not.toBe(kept.recipe.digest)
  })
})

describe('uniq FYP versions', () => {
  it('soft: zoom and +1 % speed in the platform profile', async () => {
    const r = await buildUniqVersion({
      input: fx.files.vertical,
      outDir: await freshDir('u1'),
      level: 'soft',
      n: 1,
      versions,
    })
    expect(r.params).toMatchObject({ zoomPct: 1, speedPct: 1, trimEndSec: 0 })
    expect([r.file.width, r.file.height]).toEqual([720, 1280])
    expect(r.file.durationMs).toBeGreaterThan(940)
    expect(r.file.durationMs).toBeLessThan(1010)
  })

  it('trim cuts the end; mirror flips; versions differ', async () => {
    const trim = await buildUniqVersion({
      input: fx.files.scenes,
      outDir: await freshDir('ut'),
      level: 'trim',
      n: 1,
      versions,
    })
    // 9 s / 1.01 − 0.3 s
    expect(Math.abs((trim.file.durationMs ?? 0) - (9000 / 1.01 - 300))).toBeLessThan(80)
    const soft = await buildUniqVersion({
      input: fx.files.lowrate,
      outDir: await freshDir('us'),
      level: 'soft',
      n: 2,
      versions,
    })
    const mirror = await buildUniqVersion({
      input: fx.files.lowrate,
      outDir: await freshDir('um'),
      level: 'mirror',
      n: 2,
      versions,
    })
    expect(mirror.file.sha256).not.toBe(soft.file.sha256)
    // Same n, so the mirror flipped back is the soft version up to encoding noise.
    const a = await firstFrame(soft.file.path)
    const b = await firstFrame(mirror.file.path, true)
    expect(b.length).toBe(a.length)
    let diff = 0
    for (let i = 0; i < a.length; i++) diff += Math.abs((a[i] as number) - (b[i] as number))
    expect(diff / a.length).toBeLessThan(6)
  })
})

describe('compatible H.264 copy', () => {
  it('turns an AV1 file into 8-bit H.264 at source size and frame count', async () => {
    const { file } = await buildCompatibleCopy({
      input: fx.files.av1,
      outDir: await freshDir('cc'),
      versions,
    })
    const [src, out] = await Promise.all([probeVideo(fx.files.av1), probeVideo(file.path)])
    expect(out.video).toMatchObject({
      codec: 'h264',
      pixFmt: 'yuv420p',
      width: src.video.width,
      height: src.video.height,
    })
    expect(out.video.nbFrames).toBe(src.video.nbFrames)
  })
})

describe('metadata-stripped exports', () => {
  it('video: tags gone, picture and sound bit for bit, rotation kept', async () => {
    const { file } = await stripVideoMetadata({
      input: fx.files.vfr120,
      outDir: await freshDir('sv'),
      versions,
    })
    const p = await probeVideo(file.path)
    expect(
      Object.keys(p.tags).filter(
        (t) => !['major_brand', 'minor_version', 'compatible_brands'].includes(t),
      ),
    ).toEqual([])
    expect(await streamHashes(file.path, '0:v')).toBe(await streamHashes(fx.files.vfr120, '0:v'))
    expect(await streamHashes(file.path, '0:a')).toBe(await streamHashes(fx.files.vfr120, '0:a'))
    const turned = await stripVideoMetadata({
      input: fx.files.vertical,
      outDir: await freshDir('sv2'),
      versions,
    })
    expect((await probeVideo(turned.file.path)).video.rotation).toBe(90)
  })

  it('JPEG: EXIF removed except orientation, pixels untouched', async () => {
    const { file, lossless } = await stripPhotoMetadata({
      input: fx.files.rotatedJpeg,
      outDir: await freshDir('sj'),
      versions,
    })
    expect(lossless).toBe(true)
    const tags = (await exifr.parse(await readFile(file.path), {
      translateValues: false,
    })) as Record<string, unknown>
    expect(Object.keys(tags)).toEqual(['Orientation'])
    expect([file.width, file.height]).toEqual([400, 600])
    const [a, b] = await Promise.all([
      sharp(fx.files.rotatedJpeg).raw().toBuffer(),
      sharp(file.path).raw().toBuffer(),
    ])
    expect(b.equals(a)).toBe(true)
  })

  it('PNG: text chunks removed; HEIC: JPEG with orientation applied, no EXIF', async () => {
    const png = await stripPhotoMetadata({
      input: fx.files.smallPng,
      outDir: await freshDir('sp'),
      versions,
    })
    expect((await readFile(png.file.path)).includes('tEXt')).toBe(false)
    expect((await readFile(fx.files.smallPng)).includes('tEXt')).toBe(true)
    const heic = await stripPhotoMetadata({
      input: fx.files.heic48mp,
      outDir: await freshDir('sh'),
      versions,
    })
    expect(heic.lossless).toBe(false)
    expect(heic.file).toMatchObject({ name: 'stripped.jpg', width: 8064, height: 6048 })
    expect((await sharp(heic.file.path).metadata()).exif).toBeUndefined()
  })
})
