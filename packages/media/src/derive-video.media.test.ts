import { beforeAll, describe, expect, inject, it } from 'vitest'
import {
  buildVideoDerivatives,
  VIDEO_DERIVATIVE_KINDS,
  type VideoDerivatives,
} from './derive-video.ts'
import { sha256File } from './files.ts'
import { probeVideo } from './probe.ts'
import { freshDir, listFiles, toolVersions } from './testing/helpers.ts'
import { MediaAbortError, type ToolVersions } from './tools.ts'

const fx = inject('fixtures')
let versions: ToolVersions

beforeAll(async () => {
  versions = await toolVersions()
})

function sizes(d: VideoDerivatives): Record<string, [number, number]> {
  return Object.fromEntries(d.artifacts.map((a) => [a.name, [a.width, a.height]]))
}

describe('video renditions — one decoding pass (SPEC §9.3)', () => {
  it('4K60 HDR → SDR preview at 30 fps, stills from the same pass', async () => {
    const outDir = await freshDir('hdr')
    const d = await buildVideoDerivatives({ input: fx.files.hdr4k60, outDir, versions })
    expect(sizes(d)).toEqual({
      'preview.mp4': [1280, 720],
      'poster.webp': [640, 360],
      'thumb-640.webp': [640, 360],
      'thumb-320.webp': [320, 180],
      'frames/0000.webp': [512, 288],
    })
    expect(await listFiles(outDir)).toEqual(
      ['frames/0000.webp', 'poster.webp', 'preview.mp4', 'thumb-320.webp', 'thumb-640.webp'].sort(),
    )
    for (const a of d.artifacts) expect(await sha256File(a.path)).toBe(a.sha256)
    const preview = await probeVideo(`${outDir}/preview.mp4`)
    expect(preview.video).toMatchObject({
      codec: 'h264',
      pixFmt: 'yuv420p',
      colorTransfer: 'bt709',
      isHdr: false,
    })
    expect(preview.video.fpsNum / preview.video.fpsDen).toBe(30)
    expect(preview.audio.map((a) => [a.codec, a.channels])).toEqual([['aac', 2]])
    expect(Object.keys(preview.tags)).not.toContain('creation_time')
    expect(Object.keys(d.recipes).sort()).toEqual([...VIDEO_DERIVATIVE_KINDS].sort())
  })

  it('portrait stays portrait', async () => {
    const d = await buildVideoDerivatives({
      input: fx.files.vertical,
      outDir: await freshDir('v'),
      versions,
    })
    expect(sizes(d)).toEqual({
      'preview.mp4': [720, 1280],
      'poster.webp': [360, 640],
      'thumb-640.webp': [360, 640],
      'thumb-320.webp': [180, 320],
      'frames/0000.webp': [288, 512],
    })
  })

  it('never upscales', async () => {
    const d = await buildVideoDerivatives({
      input: fx.files.lowrate,
      outDir: await freshDir('small'),
      versions,
    })
    for (const [name, size] of Object.entries(sizes(d))) expect(size, name).toEqual([320, 180])
  })

  it('120 fps inserts → preview capped to 30 CFR', async () => {
    const d = await buildVideoDerivatives({
      input: fx.files.vfr120,
      outDir: await freshDir('vfr'),
      kinds: ['preview'],
      versions,
    })
    const p = await probeVideo(d.artifacts[0]?.path as string)
    expect(p.video.fpsNum / p.video.fpsDen).toBe(30)
  })

  it('annotation frames every 4 s plus scene changes, the moment in the name', async () => {
    const d = await buildVideoDerivatives({
      input: fx.files.scenes,
      outDir: await freshDir('scenes'),
      kinds: ['frames'],
      versions,
    })
    expect(d.artifacts.map((a) => [a.name, a.frameMs])).toEqual([
      ['frames/0000.webp', 0],
      ['frames/0004.webp', 4000],
      ['frames/0005.webp', 5000],
    ])
  })

  it('builds only the requested kinds (a recipe change rebuilds one kind)', async () => {
    const outDir = await freshDir('thumbs')
    const d = await buildVideoDerivatives({
      input: fx.files.vertical,
      outDir,
      kinds: ['thumb320'],
      versions,
    })
    expect(await listFiles(outDir)).toEqual(['thumb-320.webp'])
    expect(Object.keys(d.recipes)).toEqual(['thumb320'])
  })

  it('a broken source still gives a preview, with the errors reported', async () => {
    const d = await buildVideoDerivatives({
      input: fx.files.corrupt,
      outDir: await freshDir('broken'),
      kinds: ['preview', 'thumb320'],
      versions,
    })
    expect(d.artifacts.map((a) => a.name).sort()).toEqual(['preview.mp4', 'thumb-320.webp'])
    expect(d.decodeErrors.count).toBeGreaterThan(0)
  })

  it('abort leaves nothing behind', async () => {
    const outDir = await freshDir('abort')
    const controller = new AbortController()
    const run = buildVideoDerivatives({
      input: fx.files.hdr4k60,
      outDir,
      versions,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })
    await expect(run).rejects.toBeInstanceOf(MediaAbortError)
    expect(await listFiles(outDir)).toEqual([])
  })
})
