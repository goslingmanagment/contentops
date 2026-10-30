import { stat } from 'node:fs/promises'
import { type DigestedRecipe, digested, recipe } from './recipe.ts'
import { runTool, type ToolPaths, type ToolVersions, toolPaths } from './tools.ts'

/**
 * ffprobe → typed result (schema `blob_probes`). The cache key is
 * `(sha256, kind, recipe_digest)` where the digest covers the ffprobe build and the
 * entries read (SPEC §12.0: probes are computed once per blob and tool version).
 */

export interface AudioTrack {
  /** Absolute stream index in the file. */
  index: number
  /** Index among audio streams (`0:a:N`). */
  audioIndex: number
  codec: string
  codecTag: string
  channels: number | null
  sampleRate: number | null
  bitRate: number | null
  language: string | null
  /** iPhone spatial audio (`apple_apac`), which MP4 cannot carry and FFmpeg cannot decode. */
  applePositional: boolean
}

export interface VideoStream {
  index: number
  codec: string
  codecTag: string
  profile: string | null
  pixFmt: string | null
  bitDepth: number | null
  /** Coded size. */
  width: number
  height: number
  /** Clockwise degrees a player turns the picture: 0, 90, 180, 270. */
  rotation: number
  displayWidth: number
  displayHeight: number
  /** `avg_frame_rate`. */
  fpsNum: number
  fpsDen: number
  /** `r_frame_rate`. */
  rFpsNum: number
  rFpsDen: number
  isVfr: boolean
  /** Frames the container promises (`nb_frames`), when it says. */
  nbFrames: number | null
  colorTransfer: string | null
  colorPrimaries: string | null
  colorSpace: string | null
  dolbyVision: boolean
  isHdr: boolean
  durationMs: number | null
  startMs: number | null
}

export interface Camera {
  make: string | null
  model: string | null
  software: string | null
}

export interface ShotTime {
  /** UTC instant, ISO 8601, when the source says it with a zone. */
  shotAt: string | null
  /** Wall clock as written, `YYYY-MM-DDTHH:MM:SS`, when there is one. */
  shotAtLocal: string | null
  /** `+03:00`; null when the source has no zone (no invented UTC). */
  shotTz: string | null
}

export interface VideoProbe extends ShotTime {
  kind: 'video'
  formatName: string
  sizeBytes: number
  durationMs: number
  /** File size × 8 / duration, bit/s — the measure of the 8 Mbit/s rule. */
  bitRate: number
  video: VideoStream
  audio: AudioTrack[]
  /** Data, subtitle and attachment streams. */
  otherStreams: number
  tags: Record<string, string>
  camera: Camera | null
  raw: FfprobeJson
}

export interface FfprobeJson {
  format?: {
    format_name?: string
    duration?: string
    bit_rate?: string
    size?: string
    tags?: Record<string, string>
  }
  streams?: FfprobeStream[]
}

export interface FfprobeStream {
  index: number
  codec_type?: string
  codec_name?: string
  codec_tag_string?: string
  profile?: string
  pix_fmt?: string
  bits_per_raw_sample?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  nb_frames?: string
  duration?: string
  start_time?: string
  color_transfer?: string
  color_primaries?: string
  color_space?: string
  channels?: number
  sample_rate?: string
  bit_rate?: string
  tags?: Record<string, string>
  side_data_list?: { side_data_type?: string; rotation?: number }[]
}

/** The source cannot be read as video (SPEC §9.2: waits for a replacement). */
export class UnreadableMediaError extends Error {
  override name = 'UnreadableMediaError'
  readonly stderr: string
  constructor(message: string, stderr: string) {
    super(message)
    this.stderr = stderr
  }
}

export const PROBE_ARGS = [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
] as const

export function probeRecipe(versions: ToolVersions): DigestedRecipe {
  return digested(
    recipe('probe', 'video', { args: [...PROBE_ARGS], parser: 1 }, versions, ['ffprobe']),
  )
}

export async function probeVideo(
  path: string,
  options: { paths?: ToolPaths; signal?: AbortSignal } = {},
): Promise<VideoProbe> {
  const paths = options.paths ?? toolPaths()
  const [run, info] = await Promise.all([
    runTool(paths.ffprobe, [...PROBE_ARGS, path], {
      captureStdout: true,
      signal: options.signal,
    }),
    stat(path),
  ])
  if (run.code !== 0) throw new UnreadableMediaError(`ffprobe cannot read ${path}`, run.stderrTail)
  let json: FfprobeJson
  try {
    json = JSON.parse(run.stdout) as FfprobeJson
  } catch {
    throw new UnreadableMediaError(`ffprobe returned no JSON for ${path}`, run.stderrTail)
  }
  return parseFfprobe(json, info.size, run.stderrTail)
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67'])

export function parseFfprobe(json: FfprobeJson, sizeBytes: number, stderr = ''): VideoProbe {
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !isAttachedPicture(s))
  const durationSec = Number(json.format?.duration)
  if (!v?.codec_name || !v.width || !v.height) {
    throw new UnreadableMediaError('no readable video stream', stderr)
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new UnreadableMediaError('no duration', stderr)
  }
  const rotation = rotationOf(v)
  const turned = rotation === 90 || rotation === 270
  const [fpsNum, fpsDen] = rational(v.avg_frame_rate)
  const [rFpsNum, rFpsDen] = rational(v.r_frame_rate)
  const avg = fpsDen ? fpsNum / fpsDen : 0
  const r = rFpsDen ? rFpsNum / rFpsDen : 0
  const transfer = v.color_transfer ?? null
  const dolbyVision = (v.side_data_list ?? []).some((d) => /dovi/i.test(d.side_data_type ?? ''))
  const video: VideoStream = {
    index: v.index,
    codec: v.codec_name,
    codecTag: v.codec_tag_string ?? '',
    profile: v.profile ?? null,
    pixFmt: v.pix_fmt ?? null,
    bitDepth: bitDepthOf(v),
    width: v.width,
    height: v.height,
    rotation,
    displayWidth: turned ? v.height : v.width,
    displayHeight: turned ? v.width : v.height,
    fpsNum,
    fpsDen,
    rFpsNum,
    rFpsDen,
    isVfr: avg > 0 && r > 0 && Math.abs(avg - r) / r > 0.01,
    nbFrames: positiveInt(v.nb_frames),
    colorTransfer: transfer,
    colorPrimaries: v.color_primaries ?? null,
    colorSpace: v.color_space ?? null,
    dolbyVision,
    isHdr: (transfer !== null && HDR_TRANSFERS.has(transfer)) || dolbyVision,
    durationMs: msOf(v.duration),
    startMs: msOf(v.start_time),
  }
  let audioIndex = 0
  const audio: AudioTrack[] = []
  let otherStreams = 0
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      const codec = s.codec_name ?? 'unknown'
      const codecTag = s.codec_tag_string ?? ''
      audio.push({
        index: s.index,
        audioIndex: audioIndex++,
        codec,
        codecTag,
        channels: s.channels ?? null,
        sampleRate: positiveInt(s.sample_rate),
        bitRate: positiveInt(s.bit_rate),
        language: s.tags?.language ?? null,
        applePositional: codec === 'apple_apac' || codecTag === 'apac',
      })
    } else if (s !== v && s.codec_type !== 'video') {
      otherStreams++
    }
  }
  const tags = { ...(json.format?.tags ?? {}) }
  return {
    kind: 'video',
    formatName: json.format?.format_name ?? '',
    sizeBytes,
    durationMs: Math.round(durationSec * 1000),
    bitRate: (sizeBytes * 8) / durationSec,
    video,
    audio,
    otherStreams,
    tags,
    ...videoShotTime(tags),
    camera: videoCamera(tags),
    raw: json,
  }
}

function isAttachedPicture(s: FfprobeStream): boolean {
  return (s as { disposition?: { attached_pic?: number } }).disposition?.attached_pic === 1
}

function rotationOf(s: FfprobeStream): number {
  const matrix = (s.side_data_list ?? []).find((d) => typeof d.rotation === 'number')
  let ccw = matrix?.rotation
  if (ccw === undefined && s.tags?.rotate) ccw = -Number(s.tags.rotate)
  if (ccw === undefined || !Number.isFinite(ccw)) return 0
  const cw = (((-Math.round(ccw / 90) * 90) % 360) + 360) % 360
  return cw
}

function bitDepthOf(s: FfprobeStream): number | null {
  const raw = positiveInt(s.bits_per_raw_sample)
  if (raw) return raw
  const m = /p(\d{2})(le|be)$/.exec(s.pix_fmt ?? '')
  if (m?.[1]) return Number(m[1])
  return s.pix_fmt ? 8 : null
}

export function rational(value: string | undefined): [number, number] {
  const [n, d] = (value ?? '0/0').split('/').map(Number)
  if (!n || !d || !Number.isFinite(n) || !Number.isFinite(d)) return [0, 0]
  return [n, d]
}

function positiveInt(value: string | number | undefined): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function msOf(value: string | undefined): number | null {
  const n = Number(value)
  return value !== undefined && Number.isFinite(n) ? Math.round(n * 1000) : null
}

/** QuickTime keeps the wall clock with its zone; `creation_time` is UTC only. */
function videoShotTime(tags: Record<string, string>): ShotTime {
  const apple = tags['com.apple.quicktime.creationdate']
  const zoned = apple ? parseZoned(apple) : null
  if (zoned) return zoned
  const created = tags.creation_time
  if (created) {
    const at = new Date(created)
    if (!Number.isNaN(at.getTime()) && at.getTime() > 0) {
      return { shotAt: at.toISOString(), shotAtLocal: null, shotTz: null }
    }
  }
  return { shotAt: null, shotAtLocal: null, shotTz: null }
}

/** `2024-01-02T06:04:05+0300` or `…+03:00` → instant, wall clock and zone. */
export function parseZoned(value: string): ShotTime | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([+-])(\d{2}):?(\d{2})$/.exec(
      value.trim(),
    )
  if (!m) return null
  const [, y, mo, d, h, mi, s, sign, tzh, tzm] = m as unknown as string[]
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  const tz = `${sign}${tzh}:${tzm}`
  const at = new Date(`${local}${tz}`)
  if (Number.isNaN(at.getTime())) return null
  return { shotAt: at.toISOString(), shotAtLocal: local, shotTz: tz }
}

function videoCamera(tags: Record<string, string>): Camera | null {
  const make = tags['com.apple.quicktime.make'] ?? tags['com.android.manufacturer'] ?? tags.make
  const model = tags['com.apple.quicktime.model'] ?? tags['com.android.model'] ?? tags.model
  const software = tags['com.apple.quicktime.software'] ?? tags['com.android.version'] ?? null
  if (!make && !model && !software) return null
  return { make: make ?? null, model: model ?? null, software }
}
