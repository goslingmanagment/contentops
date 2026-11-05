import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import phash from 'sharp-phash'
import { fitFilter } from './derive-video.ts'
import { removeQuietly, tempPathIn } from './files.ts'
import { probeVideo, type VideoProbe } from './probe.ts'
import {
  abortAware,
  detectToolVersions,
  runTool,
  ToolError,
  type ToolPaths,
  type ToolVersions,
  throwIfAborted,
  toolPaths,
} from './tools.ts'

/**
 * The print of a video (SPEC §6.2 «Похоже на ролик»): the duration of its picture and the pHash
 * of ten frames at fixed shares of it — the middles of ten equal parts, so a title card at the
 * start or a fade at the end weighs no more than one frame. The frames come from `preview.mp4`
 * (SPEC §9.3), which intake builds anyway: ten short seeks in a light H.264, no decoding of the
 * source or the master, so the compression queue does not wait for it. The duration is the
 * video stream's: a copy with the loudness evened out has a longer audio track, not another
 * picture, and shares of the container's duration would land on other frames. Each frame is
 * fit into 512 px like the annotation frames and hashed as a photo is (`photo.ts`).
 */
export const VIDEO_PRINT_PROFILE = {
  algorithm: 'preview-frames10-dct64-sharp-phash',
  /** Shares of the picture's duration, in permille. */
  permille: [50, 150, 250, 350, 450, 550, 650, 750, 850, 950],
  frame: { longSide: 512, format: 'png' },
  seek: 'input -ss before -i, accurate',
} as const

export interface VideoPrint {
  algorithm: string
  /** `sharp-phash@<version>`, as `blob_phashes.algo_version`. */
  algoVersion: string
  /** The picture's duration: the video stream, else the container. */
  durationMs: number
  /** The pHash of each frame as 64 `0`/`1` (Postgres `bit(64)`), in the order of the shares. */
  frames: string[]
}

/** The moments of the frames in ms: never past the second frame from the end. */
export function printMoments(durationMs: number, fps: number): number[] {
  const frameMs = 1000 / (Number.isFinite(fps) && fps > 0 ? fps : 30)
  const last = Math.max(0, Math.floor(durationMs - 2 * frameMs))
  return VIDEO_PRINT_PROFILE.permille.map((share) =>
    Math.min(last, Math.floor((durationMs * share) / 1000)),
  )
}

function pictureFps(probe: VideoProbe): number {
  const v = probe.video
  if (v.fpsDen > 0 && v.fpsNum > 0) return v.fpsNum / v.fpsDen
  return v.rFpsDen > 0 ? v.rFpsNum / v.rFpsDen : 30
}

export interface VideoPrintOptions {
  /** A preview (`preview.mp4`); any video FFmpeg reads works the same. */
  input: string
  /** Where the frames are written for a moment; removed before the call returns. */
  workDir: string
  probe?: VideoProbe
  signal?: AbortSignal
  niceness?: number
  paths?: ToolPaths
  versions?: ToolVersions
}

/** One FFmpeg run with an input per moment: each seeks to its frame and writes one PNG. */
export async function videoPrint(options: VideoPrintOptions): Promise<VideoPrint> {
  const paths = options.paths ?? toolPaths()
  const signal = options.signal
  const versions = options.versions ?? (await detectToolVersions({ paths, signal }))
  const probe = options.probe ?? (await probeVideo(options.input, { paths, signal }))
  const durationMs = probe.video.durationMs ?? probe.durationMs
  const moments = printMoments(durationMs, pictureFps(probe))
  await mkdir(options.workDir, { recursive: true })
  const dir = tempPathIn(options.workDir, 'print', '')
  try {
    await mkdir(dir)
    const inputs = moments.flatMap((ms) => [
      '-ss',
      (ms / 1000).toFixed(3),
      '-threads',
      '1',
      '-i',
      options.input,
    ])
    const outputs = moments.flatMap((_, i) => [
      '-map',
      `${i}:v:0`,
      '-frames:v',
      '1',
      '-vf',
      fitFilter(VIDEO_PRINT_PROFILE.frame.longSide, false),
      '-c:v',
      'png',
      '-update',
      '1',
      join(dir, `${String(i).padStart(2, '0')}.png`),
    ])
    const run = await runTool(
      paths.ffmpeg,
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...inputs, ...outputs],
      { signal, niceness: options.niceness },
    )
    if (run.code !== 0) {
      throw new ToolError(
        `video print failed (${run.code}): ${run.stderrTail.trim().split('\n').slice(-2).join(' | ')}`,
        paths.ffmpeg,
        run.code,
        run.stderrTail,
      )
    }
    const written = new Set(await readdir(dir))
    const frames: string[] = []
    for (const [i, ms] of moments.entries()) {
      throwIfAborted(signal)
      const name = `${String(i).padStart(2, '0')}.png`
      if (!written.has(name)) {
        throw new ToolError(`no frame at ${ms} ms`, paths.ffmpeg, run.code, run.stderrTail)
      }
      frames.push(await phash(await readFile(join(dir, name))))
    }
    return {
      algorithm: VIDEO_PRINT_PROFILE.algorithm,
      algoVersion: versions.phash,
      durationMs,
      frames,
    }
  } catch (error) {
    throw abortAware(error, signal)
  } finally {
    await removeQuietly(dir)
  }
}

/** Bits that differ between the frames of two prints, frame by frame. */
export function printDistances(a: readonly string[], b: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string
    const y = b[i] as string
    let d = 0
    for (let j = 0; j < Math.max(x.length, y.length); j++) if (x[j] !== y[j]) d++
    out.push(d)
  }
  return out
}
