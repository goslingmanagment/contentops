import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { HDR_TO_SDR, type OutputFile } from './derive-video.ts'
import { removeQuietly, sha256File, tempPathIn } from './files.ts'
import { probeVideo, type VideoProbe } from './probe.ts'
import { type DigestedRecipe, digested, recipe } from './recipe.ts'
import {
  abortAware,
  detectToolVersions,
  runTool,
  ToolError,
  type ToolPaths,
  type ToolVersions,
  toolPaths,
} from './tools.ts'

/**
 * A frame of a master in full size (SPEC §9.3, schema §3.4 `extract_frame`): «Сделать фото»
 * and «Сделать обложкой» from a moment of the video. The picture is shown as a player shows
 * it (display matrix applied), HDR is tone-mapped to SDR BT.709, and the still is a JPEG
 * q95 4:4:4 in sRGB — a photo of the object, not a rendition.
 */
export const FRAME_PROFILE = {
  format: 'jpeg',
  quality: 95,
  chroma: '4:4:4',
  hdr: HDR_TO_SDR,
  seek: 'accurate (-ss after -i)',
} as const

export function frameRecipe(versions: ToolVersions): DigestedRecipe {
  return digested(
    recipe('frames', 'video', { ...FRAME_PROFILE, full: true }, versions, [
      'ffmpeg',
      'libvips',
      'sharp',
    ]),
  )
}

export async function extractFrame(options: {
  input: string
  outDir: string
  atMs: number
  probe?: VideoProbe
  signal?: AbortSignal
  niceness?: number
  paths?: ToolPaths
  versions?: ToolVersions
}): Promise<{ file: OutputFile; recipe: DigestedRecipe; atMs: number }> {
  const paths = options.paths ?? toolPaths()
  const signal = options.signal
  const versions = options.versions ?? (await detectToolVersions({ paths, signal }))
  const probe = options.probe ?? (await probeVideo(options.input, { paths, signal }))
  // A moment past the end gives the last frame.
  const atMs = Math.max(0, Math.min(options.atMs, Math.max(0, probe.durationMs - 50)))
  const png = tempPathIn(options.outDir, 'frame', '.png')
  const name = `frame-${atMs}.jpg`
  const jpg = join(options.outDir, name)
  try {
    const run = await runTool(
      paths.ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        options.input,
        '-ss',
        (atMs / 1000).toFixed(3),
        '-map',
        '0:v:0',
        ...(probe.video.isHdr ? ['-filter:v', HDR_TO_SDR] : []),
        '-frames:v',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2',
        png,
      ],
      { signal, niceness: options.niceness },
    )
    if (run.code !== 0) {
      throw new ToolError(
        `frame at ${atMs} ms failed (${run.code}): ${run.stderrTail.trim().split('\n').slice(-2).join(' | ')}`,
        paths.ffmpeg,
        run.code,
        run.stderrTail,
      )
    }
    const out = await sharp(png)
      .toColourspace('srgb')
      .jpeg({ quality: FRAME_PROFILE.quality, chromaSubsampling: FRAME_PROFILE.chroma })
      .toFile(jpg)
    const [sha256, s] = await Promise.all([sha256File(jpg, signal), stat(jpg)])
    return {
      atMs,
      recipe: frameRecipe(versions),
      file: {
        name,
        path: jpg,
        sha256,
        bytes: s.size,
        mime: 'image/jpeg',
        width: out.width,
        height: out.height,
        durationMs: null,
      },
    }
  } catch (error) {
    await removeQuietly(jpg)
    throw abortAware(error, signal)
  } finally {
    await removeQuietly(png)
  }
}
