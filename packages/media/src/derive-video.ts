import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { removeQuietly, Scratch, sha256File, tempPathIn } from './files.ts'
import { probeVideo, type VideoProbe } from './probe.ts'
import { type DigestedRecipe, digested, type RenditionKind, recipe } from './recipe.ts'
import {
  abortAware,
  detectToolVersions,
  type FfmpegProgress,
  progressParser,
  runTool,
  ToolError,
  type ToolPaths,
  type ToolVersions,
  throwIfAborted,
  toolPaths,
} from './tools.ts'
import { encodeLogParser, errorLog } from './verify.ts'

/**
 * Video renditions built at intake in ONE decoding pass (SPEC §9.3, §12.0): `preview.mp4`,
 * `poster.webp`, `thumb-320.webp`, `thumb-640.webp` and `frames/NNNN.webp` for future
 * annotation. FFmpeg decodes once and writes the preview plus lossless stills; sharp turns
 * the stills into WebP with the same encoder and settings as photo renditions.
 */

export type VideoDerivativeKind = 'preview' | 'poster' | 'thumb320' | 'thumb640' | 'frames'
export const VIDEO_DERIVATIVE_KINDS: readonly VideoDerivativeKind[] = [
  'preview',
  'poster',
  'thumb320',
  'thumb640',
  'frames',
]

/** SPEC §9.3 `preview.mp4`; CRF 23 under a 2 Mbit/s cap until measured on the pilot. */
export const PREVIEW_PROFILE = {
  maxLongSide: 1280,
  maxFps: 30,
  codec: 'libx264',
  profile: 'high',
  preset: 'medium',
  crf: 23,
  maxrateKbps: 2000,
  bufsizeKbps: 4000,
  pixFmt: 'yuv420p',
  keyintSeconds: 2,
  minKeyintSeconds: 1,
  audio: { codec: 'aac', bitrateKbps: 128, channels: 2 },
  movflags: '+faststart',
  metadata: 'none',
} as const

/** HDR (PQ/HLG) → SDR BT.709, applied after the first downscale. */
export const HDR_TO_SDR =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'

export const VIDEO_STILLS_PROFILE = {
  /** All stills come from the shared ≤1280 px, SDR intermediate. */
  intermediate: 'fit1280',
  poster: { longSide: 640, pick: 'first frame' },
  thumbs: { pick: 'ffmpeg thumbnail filter over the first batch', batchFrames: 90 },
  thumb320: { longSide: 320 },
  thumb640: { longSide: 640 },
  frames: { longSide: 512, everySeconds: 4, sceneThreshold: 0.3, sceneMinGapSeconds: 1 },
  /** SPEC §9.3: WebP quality 80, sRGB, no ICC, orientation applied, no upscaling. */
  webp: { quality: 80, effort: 4 },
  naming: 'frames/<whole seconds from the first frame, 4+ digits>.webp',
} as const

/** A finished file: what `rendition_artifacts` and download receipts record. */
export interface OutputFile {
  /** Manifest name (SPEC §9.3): `preview.mp4`, `frames/0042.webp`, … */
  name: string
  /** Complete file inside `outDir`. */
  path: string
  sha256: string
  bytes: number
  mime: string
  /** As displayed. */
  width: number
  height: number
  durationMs: number | null
}

/** A rendition file (schema `rendition_artifacts`). */
export interface Artifact extends OutputFile {
  kind: RenditionKind
  /** Moment of a frame for annotation. */
  frameMs: number | null
}

export interface VideoDerivatives {
  artifacts: Artifact[]
  /** Recipe and digest per kind (`rendition_generations.recipe_digest`). */
  recipes: Partial<Record<VideoDerivativeKind, DigestedRecipe>>
  /** Decode errors seen in the pass (a broken source can still give a preview). */
  decodeErrors: { count: number; lines: string[] }
  ffmpegMs: number
  totalMs: number
}

export interface VideoDerivativeOptions {
  input: string
  /**
   * Where finished files go, under their manifest names; same filesystem as `derived/`.
   * Only complete files appear here; failure or abort leaves nothing.
   */
  outDir: string
  kinds?: readonly VideoDerivativeKind[]
  probe?: VideoProbe
  signal?: AbortSignal
  niceness?: number
  onProgress?: (progress: FfmpegProgress) => void
  paths?: ToolPaths
  versions?: ToolVersions
}

const STILL_TOOLS = ['ffmpeg', 'libvips', 'sharp', 'libwebp'] as const

export function videoDerivativeRecipes(
  versions: ToolVersions,
): Record<VideoDerivativeKind, DigestedRecipe> {
  const stills = (kind: VideoDerivativeKind, own: object) =>
    digested(
      recipe(
        kind,
        'video',
        {
          ...own,
          intermediate: VIDEO_STILLS_PROFILE.intermediate,
          hdr: HDR_TO_SDR,
          webp: VIDEO_STILLS_PROFILE.webp,
        },
        versions,
        STILL_TOOLS,
      ),
    )
  return {
    preview: digested(
      recipe('preview', 'video', { ...PREVIEW_PROFILE, hdr: HDR_TO_SDR }, versions, ['ffmpeg']),
    ),
    poster: stills('poster', VIDEO_STILLS_PROFILE.poster),
    thumb320: stills('thumb320', {
      ...VIDEO_STILLS_PROFILE.thumbs,
      ...VIDEO_STILLS_PROFILE.thumb320,
    }),
    thumb640: stills('thumb640', {
      ...VIDEO_STILLS_PROFILE.thumbs,
      ...VIDEO_STILLS_PROFILE.thumb640,
    }),
    frames: stills('frames', VIDEO_STILLS_PROFILE.frames),
  }
}

/** Box fit without upscaling; `even` for H.264 4:2:0. */
export function fitFilter(longSide: number, even: boolean): string {
  return `scale=w='min(${longSide},iw)':h='min(${longSide},ih)':force_original_aspect_ratio=decrease${even ? ':force_divisible_by=2' : ''}`
}

/** Source frame rate used for «выше 30 → 30 CFR»: the larger of avg and r (r ≤ 240). */
export function sourceFps(probe: VideoProbe): number {
  const v = probe.video
  const avg = v.fpsDen ? v.fpsNum / v.fpsDen : 0
  const r = v.rFpsDen ? v.rFpsNum / v.rFpsDen : 0
  return Math.max(avg, r <= 240 ? r : 0)
}

export function firstDecodableAudio(probe: VideoProbe): number | null {
  const track = probe.audio.find((a) => !a.applePositional && a.codec !== 'unknown')
  return track ? track.audioIndex : null
}

interface PassPlan {
  args: string[]
  stills: { kind: Exclude<VideoDerivativeKind, 'preview' | 'frames'>; png: string; name: string }[]
  framesDir: string | null
}

export function videoPassArgs(
  input: string,
  workDir: string,
  probe: VideoProbe,
  kinds: readonly VideoDerivativeKind[],
): PassPlan {
  const want = new Set(kinds)
  const s = VIDEO_STILLS_PROFILE
  const branches: string[] = []
  const outputs: string[] = []
  const stills: PassPlan['stills'] = []
  let framesDir: string | null = null
  const labels: string[] = []
  const fps = sourceFps(probe)
  const capFps = fps > PREVIEW_PROFILE.maxFps + 0.5

  if (want.has('preview')) {
    labels.push('pv0')
    branches.push(`[pv0]${capFps ? `fps=${PREVIEW_PROFILE.maxFps},` : ''}format=yuv420p[pv]`)
    const outFps = capFps ? PREVIEW_PROFILE.maxFps : Math.max(1, Math.round(fps || 30))
    const audio = firstDecodableAudio(probe)
    const p = PREVIEW_PROFILE
    outputs.push(
      '-map',
      '[pv]',
      ...(audio === null ? ['-an'] : ['-map', `0:a:${audio}`]),
      '-c:v',
      p.codec,
      '-profile:v',
      p.profile,
      '-preset',
      p.preset,
      '-crf',
      String(p.crf),
      '-maxrate',
      `${p.maxrateKbps}k`,
      '-bufsize',
      `${p.bufsizeKbps}k`,
      '-g',
      String(outFps * p.keyintSeconds),
      '-keyint_min',
      String(outFps * p.minKeyintSeconds),
      '-pix_fmt',
      p.pixFmt,
      ...(capFps ? [] : ['-fps_mode', 'passthrough']),
      ...(audio === null
        ? []
        : [
            '-c:a',
            p.audio.codec,
            '-b:a',
            `${p.audio.bitrateKbps}k`,
            '-ac',
            String(p.audio.channels),
          ]),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-movflags',
      p.movflags,
      '-f',
      'mp4',
      join(workDir, 'preview.mp4'),
    )
  }
  if (want.has('poster')) {
    labels.push('po0')
    branches.push(`[po0]trim=end_frame=1,${fitFilter(s.poster.longSide, false)},format=rgb24[po]`)
    const png = join(workDir, 'poster.png')
    stills.push({ kind: 'poster', png, name: 'poster.webp' })
    outputs.push('-map', '[po]', '-frames:v', '1', '-update', '1', '-c:v', 'png', png)
  }
  const thumbs = (['thumb640', 'thumb320'] as const).filter((k) => want.has(k))
  if (thumbs.length > 0) {
    labels.push('th0')
    const outs = thumbs.map((k) => `[${k}]`)
    const sizes = thumbs.map((k) => s[k].longSide)
    if (thumbs.length === 1) {
      branches.push(
        `[th0]thumbnail=n=${s.thumbs.batchFrames},${fitFilter(sizes[0] as number, false)},format=rgb24${outs[0]}`,
      )
    } else {
      branches.push(
        `[th0]thumbnail=n=${s.thumbs.batchFrames},split=2[tha][thb];` +
          `[tha]${fitFilter(sizes[0] as number, false)},format=rgb24${outs[0]};` +
          `[thb]${fitFilter(sizes[1] as number, false)},format=rgb24${outs[1]}`,
      )
    }
    for (const k of thumbs) {
      const name = k === 'thumb320' ? 'thumb-320.webp' : 'thumb-640.webp'
      const png = join(workDir, `${k}.png`)
      stills.push({ kind: k, png, name })
      outputs.push('-map', `[${k}]`, '-frames:v', '1', '-update', '1', '-c:v', 'png', png)
    }
  }
  if (want.has('frames')) {
    labels.push('fr0')
    const f = s.frames
    const select = `eq(n\\,0)+gte(t-prev_selected_t\\,${f.everySeconds})+gt(scene\\,${f.sceneThreshold})*gte(t-prev_selected_t\\,${f.sceneMinGapSeconds})`
    branches.push(
      `[fr0]${fitFilter(f.longSide, false)},select='${select}',showinfo,format=rgb24[fr]`,
    )
    framesDir = join(workDir, 'frames-png')
    outputs.push(
      '-map',
      '[fr]',
      '-fps_mode',
      'passthrough',
      '-c:v',
      'png',
      '-f',
      'image2',
      join(framesDir, '%06d.png'),
    )
  }
  if (labels.length === 0) throw new Error('no video derivative requested')

  const head = `[0:v:0]${fitFilter(PREVIEW_PROFILE.maxLongSide, true)}${probe.video.isHdr ? `,${HDR_TO_SDR}` : ''}`
  const split =
    labels.length === 1
      ? `${head}[${labels[0]}]`
      : `${head},split=${labels.length}${labels.map((l) => `[${l}]`).join('')}`
  const graph = [split, ...branches].join(';')
  return {
    args: [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'level+info',
      '-progress',
      'pipe:1',
      '-y',
      '-i',
      input,
      '-filter_complex',
      graph,
      ...outputs,
    ],
    stills,
    framesDir,
  }
}

export function frameName(frameMs: number): string {
  return `frames/${String(Math.floor(frameMs / 1000)).padStart(4, '0')}.webp`
}

export async function buildVideoDerivatives(
  options: VideoDerivativeOptions,
): Promise<VideoDerivatives> {
  const started = performance.now()
  const paths = options.paths ?? toolPaths()
  const signal = options.signal
  const kinds = options.kinds ?? VIDEO_DERIVATIVE_KINDS
  const versions = options.versions ?? (await detectToolVersions({ paths, signal }))
  const allRecipes = videoDerivativeRecipes(versions)
  const probe = options.probe ?? (await probeVideo(options.input, { paths, signal }))
  await mkdir(options.outDir, { recursive: true })
  const scratch = new Scratch()
  const workDir = scratch.track(tempPathIn(options.outDir, 'derive', ''))
  try {
    await mkdir(workDir)
    const plan = videoPassArgs(options.input, workDir, probe, kinds)
    if (plan.framesDir) await mkdir(plan.framesDir)
    const framePts: number[] = []
    const decodeErrors = errorLog()
    const encoder = errorLog()
    const run = await runTool(paths.ffmpeg, plan.args, {
      signal,
      niceness: options.niceness,
      onStdoutLine: progressParser(probe.durationMs, options.onProgress),
      onStderrLine: encodeLogParser({
        onFrame: (t) => framePts.push(t),
        source: decodeErrors,
        encoder,
      }),
    })
    const ffmpegMs = Math.round(performance.now() - started)
    if (run.code !== 0) {
      throw new ToolError(
        `video derivatives failed (${run.code}): ${run.stderrTail.trim().split('\n').slice(-3).join(' | ')}`,
        paths.ffmpeg,
        run.code,
        run.stderrTail,
      )
    }

    // Finished files in workDir under their manifest names, then moved out together.
    const finished: {
      kind: VideoDerivativeKind
      name: string
      file: string
      frameMs: number | null
    }[] = []
    if (kinds.includes('preview')) {
      finished.push({
        kind: 'preview',
        name: 'preview.mp4',
        file: join(workDir, 'preview.mp4'),
        frameMs: null,
      })
    }
    for (const still of plan.stills) {
      throwIfAborted(signal)
      const file = join(workDir, still.name)
      await toWebp(still.png, file)
      finished.push({ kind: still.kind, name: still.name, file, frameMs: null })
    }
    if (plan.framesDir) {
      const pngs = (await readdir(plan.framesDir)).filter((n) => n.endsWith('.png')).sort()
      const first = framePts[0] ?? 0
      const seen = new Set<string>()
      for (const [i, png] of pngs.entries()) {
        throwIfAborted(signal)
        const pts = framePts[i]
        const frameMs = pts === undefined ? i * 1000 : Math.max(0, Math.round((pts - first) * 1000))
        const name = frameName(frameMs)
        if (seen.has(name)) continue
        seen.add(name)
        const file = join(workDir, name)
        await mkdir(dirname(file), { recursive: true })
        await toWebp(join(plan.framesDir, png), file)
        finished.push({ kind: 'frames', name, file, frameMs })
      }
    }

    const artifacts: Artifact[] = []
    for (const f of finished) {
      artifacts.push(await describe(f.kind, f.name, f.file, f.frameMs, paths, signal))
    }
    // Publish: move each finished file to outDir/<name>.
    const published: string[] = []
    try {
      for (const a of artifacts) {
        const target = join(options.outDir, a.name)
        await mkdir(dirname(target), { recursive: true })
        await rename(a.path, target)
        published.push(target)
        a.path = target
      }
    } catch (error) {
      for (const p of published) await removeQuietly(p)
      throw error
    }
    await scratch.cleanup()
    const recipes: VideoDerivatives['recipes'] = {}
    for (const k of kinds) recipes[k] = allRecipes[k]
    return {
      artifacts,
      recipes,
      decodeErrors: { count: decodeErrors.count, lines: decodeErrors.lines },
      ffmpegMs,
      totalMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    await scratch.cleanup()
    throw abortAware(error, signal)
  }
}

async function toWebp(png: string, out: string): Promise<void> {
  const { quality, effort } = VIDEO_STILLS_PROFILE.webp
  await sharp(png).webp({ quality, effort }).toFile(out)
}

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.webp': 'image/webp' }

async function describe(
  kind: VideoDerivativeKind,
  name: string,
  file: string,
  frameMs: number | null,
  paths: ToolPaths,
  signal: AbortSignal | undefined,
): Promise<Artifact> {
  const [sha256, info] = await Promise.all([sha256File(file, signal), stat(file)])
  const ext = name.slice(name.lastIndexOf('.'))
  let width = 0
  let height = 0
  let durationMs: number | null = null
  if (ext === '.mp4') {
    const p = await probeVideo(file, { paths, signal })
    width = p.video.displayWidth
    height = p.video.displayHeight
    durationMs = p.durationMs
  } else {
    const m = await sharp(file).metadata()
    width = m.width ?? 0
    height = m.height ?? 0
  }
  return {
    kind: kind as RenditionKind,
    name,
    path: file,
    sha256,
    bytes: info.size,
    mime: MIME[ext] ?? 'application/octet-stream',
    width,
    height,
    durationMs,
    frameMs,
  }
}
