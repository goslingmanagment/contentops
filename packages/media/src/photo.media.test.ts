import { join } from 'node:path'
import sharp from 'sharp'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { sha256File } from './files.ts'
import { type PhotoResult, phashDistance, processPhoto } from './photo.ts'
import { FIXTURE_PHOTO_EXIF } from './testing/fixtures.ts'
import { freshDir, listFiles, toolVersions } from './testing/helpers.ts'
import { MediaAbortError, type ToolVersions } from './tools.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

function sizes(r: PhotoResult): Record<string, [number, number]> {
  return Object.fromEntries(r.artifacts.map((a) => [a.name, [a.width, a.height]]))
}

async function run(input: string, label: string) {
  const outDir = await freshDir(label)
  return { outDir, result: await processPhoto({ input, outDir, versions }) }
}

describe('photo job (SPEC §9.3, §12.0 «Фото»)', () => {
  it('HEIC 48 MP: reads EXIF, builds every rendition, leaves the source untouched', async () => {
    const before = await sha256File(fx.files.heic48mp)
    const { outDir, result } = await run(fx.files.heic48mp, 'heic')
    expect(await sha256File(fx.files.heic48mp)).toBe(before)
    expect(result.probe).toMatchObject({
      format: 'heif',
      width: 8064,
      height: 6048,
      orientation: 1,
      shotAtLocal: '2024-05-06T07:08:09',
      shotTz: FIXTURE_PHOTO_EXIF.offsetTimeOriginal,
      shotAt: '2024-05-06T04:08:09.000Z',
      camera: { make: FIXTURE_PHOTO_EXIF.make, model: FIXTURE_PHOTO_EXIF.model, software: null },
    })
    expect(sizes(result)).toEqual({
      'preview-2048.webp': [2048, 1536],
      'thumb-640.webp': [640, 480],
      'thumb-320.webp': [320, 240],
      'frames/0000.webp': [512, 384],
    })
    expect(await listFiles(outDir)).toEqual(
      ['frames/0000.webp', 'preview-2048.webp', 'thumb-320.webp', 'thumb-640.webp'].sort(),
    )
    expect(result.phash.bits).toMatch(/^[01]{64}$/)
    expect(result.phash.hex).toMatch(/^[0-9a-f]{16}$/)
    expect(result.phash.algoVersion).toBe(versions.phash)
    for (const a of result.artifacts) {
      const m = await sharp(a.path).metadata()
      expect(m.format).toBe('webp')
      expect(m.icc).toBeUndefined()
      expect(m.exif).toBeUndefined()
    }
  })

  it('applies EXIF orientation and never upscales', async () => {
    const { result } = await run(fx.files.rotatedJpeg, 'rotated')
    expect(result.probe).toMatchObject({ orientation: 6, rotation: 90, width: 400, height: 600 })
    expect(sizes(result)).toEqual({
      'preview-2048.webp': [400, 600],
      'thumb-640.webp': [400, 600],
      'thumb-320.webp': [213, 320],
      'frames/0000.webp': [341, 512],
    })
    const small = await run(fx.files.smallPng, 'small')
    expect(sizes(small.result)).toEqual({
      'preview-2048.webp': [300, 200],
      'thumb-640.webp': [300, 200],
      'thumb-320.webp': [300, 200],
      'frames/0000.webp': [300, 200],
    })
  })

  it('is idempotent: the same bytes and hash on a rerun', async () => {
    const a = await run(fx.files.rotatedJpeg, 'idem-a')
    const b = await run(fx.files.rotatedJpeg, 'idem-b')
    expect(b.result.artifacts.map((x) => [x.name, x.sha256])).toEqual(
      a.result.artifacts.map((x) => [x.name, x.sha256]),
    )
    expect(b.result.phash).toEqual(a.result.phash)
  })

  it('pHash is stable across re-normalisation', async () => {
    const dir = await freshDir('phash')
    const base = (await run(fx.files.rotatedJpeg, 'phash-base')).result
    // Pixels turned for real, orientation tag gone.
    const upright = join(dir, 'upright.jpg')
    await sharp(fx.files.rotatedJpeg).rotate().jpeg({ quality: 95 }).toFile(upright)
    // Half size, heavier compression.
    const smaller = join(dir, 'smaller.jpg')
    await sharp(fx.files.rotatedJpeg).rotate().resize(200).jpeg({ quality: 60 }).toFile(smaller)
    const fromPreview = base.artifacts.find((a) => a.name === 'preview-2048.webp')?.path as string
    for (const variant of [upright, smaller, fromPreview]) {
      const other = (await run(variant, 'phash-variant')).result.phash.bits
      expect(phashDistance(base.phash.bits, other), variant).toBeLessThanOrEqual(4)
    }
    const different = (await run(fx.files.smallPng, 'phash-other')).result.phash.bits
    expect(phashDistance(base.phash.bits, different)).toBeGreaterThan(10)
  })

  it('abort leaves nothing behind', async () => {
    const outDir = await freshDir('abort')
    const controller = new AbortController()
    controller.abort()
    await expect(
      processPhoto({ input: fx.files.heic48mp, outDir, versions, signal: controller.signal }),
    ).rejects.toBeInstanceOf(MediaAbortError)
    expect(await listFiles(outDir)).toEqual([])
  })
})
