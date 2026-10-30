import type { AudioTrack, VideoProbe } from './probe.ts'
import { progressParser, runTool, type ToolPaths } from './tools.ts'

/**
 * Decode checks shared by the master and its verification (SPEC §9.2), ported from
 * `tools/compress-library.sh`: frames and PTS from decoded frames, audio by the copied
 * packets bit for bit, the audio start relative to the first shown video frame.
 */

const ERROR_LINE = /\[(error|fatal|panic)\]/
/**
 * Output-side contexts of the FFmpeg CLI: their errors are the encoder's, not the source's.
 * The muxers we write to (`null` of a check, `mp4` of a master) count as output too: a
 * timestamp they refuse is about what we feed them, not a decode error of the source.
 */
const OUTPUT_SIDE = /^(Svt\[|\[(out#|vost#|aost#|enc:|mux|null @|mp4 @))/

export interface ErrorLog {
  count: number
  /** The first lines, enough for the report. */
  lines: string[]
}

export function errorLog(): ErrorLog & { add(line: string): void } {
  return {
    count: 0,
    lines: [],
    add(line: string) {
      this.count++
      if (this.lines.length < 20) this.lines.push(line.slice(0, 400))
    },
  }
}

/**
 * Splits a `-loglevel level+info` stderr line: showinfo frames feed `onFrame`, error lines
 * go to the source or the encoder log.
 */
export function encodeLogParser(sink: {
  onFrame?: (ptsSec: number) => void
  source: ReturnType<typeof errorLog>
  encoder: ReturnType<typeof errorLog>
}): (line: string) => void {
  return (line) => {
    if (line.includes('Parsed_showinfo')) {
      const m = /\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:(\S+)/.exec(line)
      if (m?.[1] && sink.onFrame) sink.onFrame(Number(m[1]))
      return
    }
    if (/^Svt\[error\]/.test(line)) {
      sink.encoder.add(line)
      return
    }
    if (!ERROR_LINE.test(line)) return
    if (OUTPUT_SIDE.test(line)) sink.encoder.add(line)
    else sink.source.add(line)
  }
}

export interface DecodedFrames {
  pts: number[]
  errors: ErrorLog
  code: number | null
}

/** Full decode of the first video stream with the time of every frame (`ffprobe -show_frames`). */
export async function decodeFramePts(
  paths: ToolPaths,
  file: string,
  options: { signal?: AbortSignal; niceness?: number; onFrame?: (count: number) => void } = {},
): Promise<DecodedFrames> {
  const pts: number[] = []
  const errors = errorLog()
  const run = await runTool(
    paths.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=pts_time,best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      file,
    ],
    {
      signal: options.signal,
      niceness: options.niceness,
      onStdoutLine: (line) => {
        if (!line) return
        const [a, b] = line.split(',')
        const value = a && a !== 'N/A' ? Number(a) : b && b !== 'N/A' ? Number(b) : Number.NaN
        pts.push(value)
        if (options.onFrame && pts.length % 250 === 0) options.onFrame(pts.length)
      },
      onStderrLine: (line) => {
        if (line.trim()) errors.add(line)
      },
    },
  )
  return { pts, errors, code: run.code }
}

export interface PtsDrift {
  comparable: boolean
  /** Frames whose time moved more than the tolerance. */
  drifted: number
  maxDriftMs: number
}

/** Compares frame times relative to the first frame, as `tools/ts_drift.py`. */
export function ptsDrift(source: number[], result: number[], toleranceMs: number): PtsDrift {
  if (source.length === 0 || source.length !== result.length) {
    return { comparable: false, drifted: 0, maxDriftMs: 0 }
  }
  if (source.some((x) => !Number.isFinite(x)) || result.some((x) => !Number.isFinite(x))) {
    return { comparable: false, drifted: 0, maxDriftMs: 0 }
  }
  const a = [...source].sort((x, y) => x - y)
  const b = [...result].sort((x, y) => x - y)
  const a0 = a[0] as number
  const b0 = b[0] as number
  let drifted = 0
  let max = 0
  const tol = toleranceMs / 1000
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] as number) - a0 - ((b[i] as number) - b0))
    if (d > tol + 1e-9) drifted++
    if (d > max) max = d
  }
  return { comparable: true, drifted, maxDriftMs: Math.round(max * 1e6) / 1e3 }
}

/** SHA-256 of the packets of each audio stream, copied without decoding (one pass). */
export async function audioPacketHashes(
  paths: ToolPaths,
  file: string,
  audioIndexes: readonly number[] | 'all',
  options: { signal?: AbortSignal; niceness?: number } = {},
): Promise<string[]> {
  const maps =
    audioIndexes === 'all' ? ['-map', '0:a'] : audioIndexes.flatMap((i) => ['-map', `0:a:${i}`])
  if (maps.length === 0) return []
  const hashes: string[] = []
  const run = await runTool(
    paths.ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      ...maps,
      '-c',
      'copy',
      '-f',
      'streamhash',
      '-hash',
      'sha256',
      '-',
    ],
    {
      signal: options.signal,
      niceness: options.niceness,
      onStdoutLine: (line) => {
        const m = /^(\d+),a,SHA256=([0-9a-f]+)$/.exec(line.trim())
        if (m?.[1] && m[2]) hashes[Number(m[1])] = m[2]
      },
    },
  )
  if (run.code !== 0) return []
  return hashes
}

async function firstTime(
  paths: ToolPaths,
  file: string,
  select: string,
  entry: 'frame' | 'packet',
  signal: AbortSignal | undefined,
): Promise<number | null> {
  const run = await runTool(
    paths.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      select,
      '-show_entries',
      `${entry}=pts_time`,
      '-of',
      'csv=p=0',
      '-read_intervals',
      '%+#64',
      file,
    ],
    { captureStdout: true, signal },
  )
  for (const line of run.stdout.split('\n')) {
    const value = line.split(',')[0]?.trim()
    if (value && value !== 'N/A') return Number(value)
  }
  return null
}

/**
 * Audio start minus the first shown video frame, ms: video by decoded frames (B-frames and
 * edit lists put a pre-roll packet first), audio by packets (decoders trim AAC priming).
 */
export async function audioOffsetsMs(
  paths: ToolPaths,
  file: string,
  audioIndexes: readonly number[],
  signal?: AbortSignal,
): Promise<(number | null)[]> {
  if (audioIndexes.length === 0) return []
  const video = await firstTime(paths, file, 'v:0', 'frame', signal)
  return Promise.all(
    audioIndexes.map(async (i) => {
      const audio = await firstTime(paths, file, `a:${i}`, 'packet', signal)
      return video === null || audio === null ? null : (audio - video) * 1000
    }),
  )
}

export type SourceVerdict = 'ok' | 'source_decode_errors' | 'source_truncated' | 'unreadable'

export interface SourceCheck {
  verdict: SourceVerdict
  /** Decoded video frames (null when the video was decoded elsewhere). */
  frames: number | null
  promisedFrames: number | null
  errors: ErrorLog
  /** Audio tracks that cannot be decoded at all (apple_apac): not checked, noted. */
  undecodableAudio: number[]
  durationMs: number
}

/** Share of promised frames below which a source is `source_truncated` (SPEC §9.2). */
export const MIN_DECODED_SHARE = 0.95

export function truncated(decoded: number, promised: number | null): boolean {
  return promised !== null && promised > 0 && decoded < MIN_DECODED_SHARE * promised
}

/**
 * Video packets outside the edit list (`D` flag, a demux pass without decoding): the container
 * counts them in `nb_frames`, a decoder never shows them. CapCut and phone exports keep a
 * pre-roll this way.
 */
export async function discardedVideoPackets(
  paths: ToolPaths,
  file: string,
  signal?: AbortSignal,
): Promise<number> {
  let count = 0
  const run = await runTool(
    paths.ffprobe,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=flags',
      '-of',
      'csv=p=0',
      file,
    ],
    {
      signal,
      onStdoutLine: (line) => {
        if (line.includes('D')) count++
      },
    },
  )
  return run.code === 0 ? count : 0
}

/**
 * The frames a source promises to show (SPEC §9.2 `source_truncated`): `nb_frames` minus the
 * packets its edit list discards. Looked up only when the decode fell short of `nb_frames`.
 */
export async function shownFramesPromised(
  paths: ToolPaths,
  file: string,
  promised: number | null,
  decoded: number,
  signal?: AbortSignal,
): Promise<number | null> {
  if (promised === null || !truncated(decoded, promised)) return promised
  return promised - (await discardedVideoPackets(paths, file, signal))
}

/**
 * Full decode of a source that becomes the master as is: the first video stream (unless
 * already decoded by the encode pass) and every decodable audio stream.
 */
export async function checkSource(
  paths: ToolPaths,
  file: string,
  probe: VideoProbe,
  options: {
    decodeVideo?: boolean
    signal?: AbortSignal
    niceness?: number
    onProgress?: (fraction: number | null) => void
  } = {},
): Promise<SourceCheck> {
  const decodeVideo = options.decodeVideo ?? true
  const decodable = (a: AudioTrack) => !a.applePositional && a.codec !== 'unknown'
  const audio = probe.audio.filter(decodable)
  const undecodableAudio = probe.audio.filter((a) => !decodable(a)).map((a) => a.audioIndex)
  const maps = [
    ...(decodeVideo ? ['-map', '0:v:0'] : []),
    ...audio.flatMap((a) => ['-map', `0:a:${a.audioIndex}`]),
  ]
  const errors = errorLog()
  const started = performance.now()
  if (maps.length === 0) {
    return {
      verdict: 'ok',
      frames: null,
      promisedFrames: probe.video.nbFrames,
      errors,
      undecodableAudio,
      durationMs: 0,
    }
  }
  let frames = 0
  const progress = progressParser(probe.durationMs, (p) => {
    if (p.frame !== null) frames = p.frame
    options.onProgress?.(p.fraction)
  })
  const encoder = errorLog()
  const run = await runTool(
    paths.ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'level+info',
      '-progress',
      'pipe:1',
      '-i',
      file,
      ...maps,
      '-fps_mode',
      'passthrough',
      // As the master command (SPEC §9.2): VFR frames 8 ms apart in a stream whose container
      // says 30000/1001 (iPhone 120 fps inserts) collide in a 1/30 output time base.
      ...(decodeVideo ? ['-enc_time_base:v', '1/1000000'] : []),
      '-f',
      'null',
      '-',
    ],
    {
      signal: options.signal,
      niceness: options.niceness,
      onStdoutLine: progress,
      onStderrLine: encodeLogParser({ source: errors, encoder }),
    },
  )
  const durationMs = Math.round(performance.now() - started)
  const promisedFrames = decodeVideo
    ? await shownFramesPromised(paths, file, probe.video.nbFrames, frames, options.signal)
    : probe.video.nbFrames
  let verdict: SourceVerdict = 'ok'
  if (decodeVideo && frames === 0) verdict = 'unreadable'
  else if (decodeVideo && truncated(frames, promisedFrames)) verdict = 'source_truncated'
  else if (errors.count > 0 || run.code !== 0) verdict = 'source_decode_errors'
  if (run.code !== 0 && errors.count === 0) errors.add(`ffmpeg exited with ${run.code}`)
  return {
    verdict,
    frames: decodeVideo ? frames : null,
    promisedFrames,
    errors,
    undecodableAudio,
    durationMs,
  }
}
