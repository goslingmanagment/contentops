import { open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  type Artifact,
  firstDecodableAudio,
  HDR_TO_SDR,
  type OutputFile,
  sourceFps,
} from './derive-video.ts'
import { extOf, removeQuietly, sha256File, tempPathIn } from './files.ts'
import { type AudioTrack, probeVideo, type VideoProbe } from './probe.ts'
import { type DigestedRecipe, digested, recipe } from './recipe.ts'
import {
  abortAware,
  detectToolVersions,
  type FfmpegProgress,
  progressParser,
  runTool,
  ToolError,
  type ToolPaths,
  type ToolVersions,
  toolPaths,
} from './tools.ts'

/**
 * Copies built on demand (SPEC §9.3): the platform copy `platform.mp4`, FYP uniq versions,
 * the compatible H.264 copy for editing and metadata-stripped exports.
 */

export interface PlatformProfile {
  id: string
  /** Long side of the picture the platform shows the fan, px, no upscaling. */
  maxLongSide: number
  maxFps: number
  codec: 'libx264'
  profile: 'high'
  preset: string
  crf: number
  maxrateKbps: number
  bufsizeKbps: number
  keyintSeconds: number
  audioKbps: number
}

/**
 * Default until the Fansly profile is measured from Hub `raw_media` (SPEC §9.3, §13): 1080p
 * long side, ≤ 60 fps, H.264 High CRF 20 capped at 8 Mbit/s — «сотни мегабайт, не
 * гигабайты». Pass the measured profile as configuration when it exists.
 */
export const DEFAULT_PLATFORM_PROFILE: PlatformProfile = {
  id: 'default-1080p-2026-10',
  maxLongSide: 1920,
  maxFps: 60,
  codec: 'libx264',
  profile: 'high',
  preset: 'medium',
  crf: 20,
  maxrateKbps: 8000,
  bufsizeKbps: 16000,
  keyintSeconds: 2,
  audioKbps: 192,
}

export interface CopyOptions {
  input: string
  /** Finished file appears here under its name; failure or abort leaves nothing. */
  outDir: string
  /** Strip container metadata (SPEC §9.3 «стереть метаданные», part of the cache key). */
  metaStripped?: boolean
  probe?: VideoProbe
  signal?: AbortSignal
  niceness?: number
  onProgress?: (progress: FfmpegProgress) => void
  paths?: ToolPaths
  versions?: ToolVersions
}

export interface CopyResult<T extends OutputFile = OutputFile> {
  file: T
  recipe: DigestedRecipe
}

/** Even output size inside the profile box, no upscaling (display orientation). */
export function platformSize(
  displayWidth: number,
  displayHeight: number,
  maxLongSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxLongSide / Math.max(displayWidth, displayHeight))
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2)
  return { width: even(displayWidth), height: even(displayHeight) }
}

export function platformFps(probe: VideoProbe, maxFps: number): number {
  const fps = sourceFps(probe) || 30
  return fps > maxFps + 0.5 ? maxFps : Math.round(fps * 1000) / 1000
}

function h264Args(profile: PlatformProfile, fps: number): string[] {
  return [
    '-c:v',
    profile.codec,
    '-profile:v',
    profile.profile,
    '-preset',
    profile.preset,
    '-crf',
    String(profile.crf),
    '-maxrate',
    `${profile.maxrateKbps}k`,
    '-bufsize',
    `${profile.bufsizeKbps}k`,
    '-g',
    String(Math.round(fps * profile.keyintSeconds)),
    '-pix_fmt',
    'yuv420p',
  ]
}

/**
 * Container metadata and `movflags`. Kept: QuickTime keys survive only with
 * `use_metadata_tags` (as in the master). Stripped: no global, stream or chapter metadata and
 * no encoder tag.
 */
function metadataArgs(metaStripped: boolean): string[] {
  return metaStripped
    ? [
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-fflags',
        '+bitexact',
        '-movflags',
        '+faststart',
      ]
    : [
        '-map_metadata',
        '0',
        '-metadata',
        'major_brand=',
        '-metadata',
        'minor_version=',
        '-metadata',
        'compatible_brands=',
        '-movflags',
        '+faststart+use_metadata_tags',
      ]
}

function audioArgs(probe: VideoProbe, kbps: number, filter?: string): string[] {
  const a = firstDecodableAudio(probe)
  if (a === null) return ['-an']
  return [
    '-map',
    `0:a:${a}`,
    ...(filter ? ['-filter:a', filter] : []),
    '-c:a',
    'aac',
    '-b:a',
    `${kbps}k`,
    '-ac',
    '2',
  ]
}

export function platformRecipe(
  versions: ToolVersions,
  profile: PlatformProfile,
  metaStripped: boolean,
): DigestedRecipe {
  return digested(
    recipe('platform', 'video', { ...profile, hdr: HDR_TO_SDR, metaStripped }, versions, [
      'ffmpeg',
    ]),
  )
}

async function encodeTo(
  name: string,
  args: (tmp: string) => string[],
  options: CopyOptions,
  paths: ToolPaths,
  durationMs: number,
): Promise<string> {
  const tmp = tempPathIn(options.outDir, name.replace(/\W+/g, '-'), extOf(name))
  try {
    const run = await runTool(paths.ffmpeg, args(tmp), {
      signal: options.signal,
      niceness: options.niceness,
      onStdoutLine: progressParser(durationMs, options.onProgress),
    })
    if (run.code !== 0) {
      throw new ToolError(
        `${name} failed (${run.code}): ${run.stderrTail.trim().split('\n').slice(-3).join(' | ')}`,
        paths.ffmpeg,
        run.code,
        run.stderrTail,
      )
    }
    const target = join(options.outDir, name)
    await rename(tmp, target)
    return target
  } catch (error) {
    await removeQuietly(tmp)
    throw abortAware(error, options.signal)
  }
}

const COMMON_HEAD = [
  '-nostdin',
  '-hide_banner',
  '-nostats',
  '-loglevel',
  'error',
  '-progress',
  'pipe:1',
  '-y',
]

/** `platform.mp4` — what the platform shows the fan (SPEC §9.3). */
export async function buildPlatformCopy(
  options: CopyOptions & { profile?: PlatformProfile },
): Promise<CopyResult<Artifact>> {
  const paths = options.paths ?? toolPaths()
  const profile = options.profile ?? DEFAULT_PLATFORM_PROFILE
  const metaStripped = options.metaStripped ?? false
  const versions = options.versions ?? (await detectToolVersions({ paths, signal: options.signal }))
  const probe =
    options.probe ?? (await probeVideo(options.input, { paths, signal: options.signal }))
  const size = platformSize(
    probe.video.displayWidth,
    probe.video.displayHeight,
    profile.maxLongSide,
  )
  const fps = platformFps(probe, profile.maxFps)
  const vf = [
    `scale=${size.width}:${size.height}`,
    ...(probe.video.isHdr ? [HDR_TO_SDR] : []),
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',')
  const file = await encodeTo(
    'platform.mp4',
    (tmp) => [
      ...COMMON_HEAD,
      '-i',
      options.input,
      '-map',
      '0:v:0',
      '-filter:v',
      vf,
      ...h264Args(profile, fps),
      ...audioArgs(probe, profile.audioKbps),
      ...metadataArgs(metaStripped),
      '-f',
      'mp4',
      tmp,
    ],
    options,
    paths,
    probe.durationMs,
  )
  return {
    file: {
      ...(await describeVideo('platform.mp4', file, paths, options.signal)),
      kind: 'platform',
      frameMs: null,
    },
    recipe: platformRecipe(versions, profile, metaStripped),
  }
}

// ---- FYP uniq versions (SPEC §9.3) ----

export type UniqLevel = 'soft' | 'trim' | 'mirror'

export interface UniqParams {
  level: UniqLevel
  n: number
  /** Zoom toward the centre, % of each side. */
  zoomPct: number
  /** Speed change, % (+ faster), audio in step with pitch kept (`atempo`). */
  speedPct: number
  /** Seconds cut from the end (`trim` only). */
  trimEndSec: number
  mirror: boolean
}

/**
 * Deterministic table by version number, no randomness (SPEC §9.3: n=1 → 1 %, +1 %;
 * n=2 → 2 %, −1 %). Zoom walks 1, 2, 1.5, 1.25, 1.75 % and speed alternates ±1 %, so the
 * first ten versions differ pairwise; trim walks 0.3, 0.4, 0.5 s.
 */
export const UNIQ_ZOOM_PCT = [1, 2, 1.5, 1.25, 1.75] as const
export const UNIQ_TRIM_SEC = [0.3, 0.4, 0.5] as const
export const UNIQ_MAX_VERSIONS = 10

export function uniqParams(level: UniqLevel, n: number): UniqParams {
  if (!Number.isInteger(n) || n < 1 || n > UNIQ_MAX_VERSIONS) {
    throw new RangeError(`uniq version must be 1…${UNIQ_MAX_VERSIONS}, got ${n}`)
  }
  return {
    level,
    n,
    zoomPct: UNIQ_ZOOM_PCT[(n - 1) % UNIQ_ZOOM_PCT.length] as number,
    speedPct: n % 2 === 1 ? 1 : -1,
    trimEndSec: level === 'trim' ? (UNIQ_TRIM_SEC[(n - 1) % UNIQ_TRIM_SEC.length] as number) : 0,
    mirror: level === 'mirror',
  }
}

export function uniqFilters(
  params: UniqParams,
  size: { width: number; height: number },
  fps: number,
  hdr: boolean,
): { video: string; audio: string } {
  const keep = 1 - params.zoomPct / 100
  const speed = 1 + params.speedPct / 100
  const video = [
    `crop=w=trunc(iw*${keep}/2)*2:h=trunc(ih*${keep}/2)*2:x=(iw-ow)/2:y=(ih-oh)/2`,
    `scale=${size.width}:${size.height}`,
    ...(hdr ? [HDR_TO_SDR] : []),
    ...(params.mirror ? ['hflip'] : []),
    `setpts=PTS/${speed}`,
    `fps=${fps}`,
    'format=yuv420p',
  ].join(',')
  return { video, audio: `atempo=${speed}` }
}

export async function buildUniqVersion(
  options: CopyOptions & { level: UniqLevel; n: number; profile?: PlatformProfile },
): Promise<CopyResult & { params: UniqParams }> {
  const paths = options.paths ?? toolPaths()
  const profile = options.profile ?? DEFAULT_PLATFORM_PROFILE
  const params = uniqParams(options.level, options.n)
  const metaStripped = options.metaStripped ?? true
  const versions = options.versions ?? (await detectToolVersions({ paths, signal: options.signal }))
  const probe =
    options.probe ?? (await probeVideo(options.input, { paths, signal: options.signal }))
  const size = platformSize(
    probe.video.displayWidth,
    probe.video.displayHeight,
    profile.maxLongSide,
  )
  const fps = platformFps(probe, profile.maxFps)
  const f = uniqFilters(params, size, fps, probe.video.isHdr)
  const speed = 1 + params.speedPct / 100
  const outSec = probe.durationMs / 1000 / speed - params.trimEndSec
  const name = `uniq-${params.n}.mp4`
  const file = await encodeTo(
    name,
    (tmp) => [
      ...COMMON_HEAD,
      '-i',
      options.input,
      '-map',
      '0:v:0',
      '-filter:v',
      f.video,
      ...h264Args(profile, fps),
      ...audioArgs(probe, profile.audioKbps, f.audio),
      '-t',
      outSec.toFixed(3),
      ...metadataArgs(metaStripped),
      '-f',
      'mp4',
      tmp,
    ],
    options,
    paths,
    Math.round(outSec * 1000),
  )
  return {
    params,
    file: await describeVideo(name, file, paths, options.signal),
    recipe: digested(
      recipe(
        'uniq',
        'video',
        {
          platform: { ...profile },
          zoom: [...UNIQ_ZOOM_PCT],
          trim: [...UNIQ_TRIM_SEC],
          speed: '±1 % alternating',
          hdr: HDR_TO_SDR,
          metaStripped,
        },
        versions,
        ['ffmpeg'],
      ),
    ),
  }
}

// ---- compatible H.264 copy for editing (SPEC §9.3) ----

export const COMPATIBLE_PROFILE = {
  codec: 'libx264',
  profile: 'high',
  preset: 'fast',
  crf: 18,
  pixFmt: 'yuv420p',
  keyintSeconds: 1,
  size: 'source',
  fps: 'source (passthrough)',
  audio: 'copied when MP4 carries it, else AAC 256 kbit/s',
} as const

const MP4_AUDIO = new Set(['aac', 'ac3', 'eac3', 'alac', 'mp3', 'opus', 'flac'])

export async function buildCompatibleCopy(options: CopyOptions): Promise<CopyResult> {
  const paths = options.paths ?? toolPaths()
  const metaStripped = options.metaStripped ?? false
  const versions = options.versions ?? (await detectToolVersions({ paths, signal: options.signal }))
  const probe =
    options.probe ?? (await probeVideo(options.input, { paths, signal: options.signal }))
  const p = COMPATIBLE_PROFILE
  const fps = sourceFps(probe) || 30
  const tracks = probe.audio.filter((a) => !a.applePositional && a.codec !== 'unknown')
  const audio = tracks.flatMap((a: AudioTrack, i) => [
    '-map',
    `0:a:${a.audioIndex}`,
    `-c:a:${i}`,
    ...(MP4_AUDIO.has(a.codec) ? ['copy'] : ['aac', `-b:a:${i}`, '256k']),
  ])
  const vf = [...(probe.video.isHdr ? [HDR_TO_SDR] : []), 'format=yuv420p'].join(',')
  const file = await encodeTo(
    'compatible.mp4',
    (tmp) => [
      ...COMMON_HEAD,
      '-i',
      options.input,
      '-map',
      '0:v:0',
      ...audio,
      ...(tracks.length === 0 ? ['-an'] : []),
      '-filter:v',
      vf,
      '-c:v',
      p.codec,
      '-profile:v',
      p.profile,
      '-preset',
      p.preset,
      '-crf',
      String(p.crf),
      '-g',
      String(Math.max(1, Math.round(fps * p.keyintSeconds))),
      '-pix_fmt',
      p.pixFmt,
      '-fps_mode',
      'passthrough',
      ...metadataArgs(metaStripped),
      '-f',
      'mp4',
      tmp,
    ],
    options,
    paths,
    probe.durationMs,
  )
  return {
    file: await describeVideo('compatible.mp4', file, paths, options.signal),
    recipe: digested(
      recipe('compatible', 'video', { ...p, hdr: HDR_TO_SDR, metaStripped }, versions, ['ffmpeg']),
    ),
  }
}

// ---- metadata-stripped export copies (SPEC §9.3 «стереть метаданные») ----

/**
 * Video: container metadata, chapters and data tracks (timed metadata, timecode) removed;
 * picture and sound copied as they are, display matrix and colour tags kept.
 */
export async function stripVideoMetadata(
  options: Omit<CopyOptions, 'metaStripped'>,
): Promise<CopyResult> {
  const paths = options.paths ?? toolPaths()
  const versions = options.versions ?? (await detectToolVersions({ paths, signal: options.signal }))
  const probe =
    options.probe ?? (await probeVideo(options.input, { paths, signal: options.signal }))
  // Same container family as the source: MOV keeps tracks MP4 cannot carry (apple_apac).
  const mov = extOf(options.input) === '.mov'
  const name = mov ? 'stripped.mov' : 'stripped.mp4'
  const file = await encodeTo(
    name,
    (tmp) => [
      ...COMMON_HEAD,
      '-i',
      options.input,
      '-map',
      '0:v',
      '-map',
      '0:a?',
      '-c',
      'copy',
      '-map_metadata',
      '-1',
      '-map_metadata:s',
      '-1',
      '-map_chapters',
      '-1',
      '-fflags',
      '+bitexact',
      '-movflags',
      '+faststart',
      '-f',
      mov ? 'mov' : 'mp4',
      tmp,
    ],
    options,
    paths,
    probe.durationMs,
  )
  return {
    file: await describeVideo(name, file, paths, options.signal),
    recipe: digested(
      recipe(
        'strip',
        'video',
        { container: 'copy', drop: ['global', 'stream', 'chapters', 'data'] },
        versions,
        ['ffmpeg'],
      ),
    ),
  }
}

/**
 * Photo: EXIF, XMP, IPTC and comments removed. JPEG and PNG keep their pixels bit for bit
 * (segments and chunks are filtered; a non-default EXIF orientation is kept as a one-tag
 * EXIF block). Other formats — HEIC among them, which the image cannot encode — become JPEG
 * q95 with the orientation applied and the ICC profile kept.
 */
export async function stripPhotoMetadata(options: {
  input: string
  outDir: string
  versions?: ToolVersions
}): Promise<CopyResult & { lossless: boolean }> {
  const versions = options.versions ?? (await detectToolVersions())
  const meta = await sharp(options.input).metadata()
  const head = await readHead(options.input)
  let name: string
  let lossless = true
  let bytes: Buffer
  if (isJpeg(head)) {
    name = 'stripped.jpg'
    bytes = stripJpeg(await readFile(options.input), meta.orientation ?? 1)
  } else if (isPng(head)) {
    name = 'stripped.png'
    bytes = stripPng(await readFile(options.input))
  } else {
    name = 'stripped.jpg'
    lossless = false
    bytes = await sharp(options.input)
      .rotate()
      .keepIccProfile()
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toBuffer()
  }
  const tmp = tempPathIn(options.outDir, 'stripped', extOf(name))
  try {
    await writeFile(tmp, bytes)
    const target = join(options.outDir, name)
    await rename(tmp, target)
    const out = await sharp(target).metadata()
    const turned = (out.orientation ?? 1) >= 5
    return {
      lossless,
      file: {
        name,
        path: target,
        sha256: await sha256File(target),
        bytes: bytes.length,
        mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg',
        width: (turned ? out.height : out.width) ?? 0,
        height: (turned ? out.width : out.height) ?? 0,
        durationMs: null,
      },
      recipe: digested(
        recipe(
          'strip',
          'photo',
          { jpeg: 'segments', png: 'chunks', other: 'jpeg q95 4:4:4 icc kept orientation applied' },
          versions,
          ['libvips', 'sharp'],
        ),
      ),
    }
  } catch (error) {
    await removeQuietly(tmp)
    throw error
  }
}

async function readHead(path: string): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(16)
    await fh.read(buf, 0, 16, 0)
    return buf
  } finally {
    await fh.close()
  }
}

const isJpeg = (b: Buffer) => b[0] === 0xff && b[1] === 0xd8
const isPng = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

/** JPEG markers kept: JFIF (APP0), ICC (APP2 `ICC_PROFILE`), Adobe (APP14); the rest of APPn and COM go. */
export function stripJpeg(input: Buffer, orientation: number): Buffer {
  const parts: Buffer[] = [input.subarray(0, 2)]
  if (orientation > 1 && orientation <= 8) parts.push(orientationExif(orientation))
  let i = 2
  while (i + 4 <= input.length) {
    if (input[i] !== 0xff) throw new Error('broken JPEG segment')
    const marker = input[i + 1] as number
    if (marker === 0xda) {
      parts.push(input.subarray(i))
      return Buffer.concat(parts)
    }
    const length = input.readUInt16BE(i + 2)
    const segment = input.subarray(i, i + 2 + length)
    const isApp = marker >= 0xe0 && marker <= 0xef
    const keep =
      !isApp && marker !== 0xfe
        ? true
        : marker === 0xe0 ||
          marker === 0xee ||
          (marker === 0xe2 && segment.subarray(4, 15).toString('latin1') === 'ICC_PROFILE')
    if (keep) parts.push(segment)
    i += 2 + length
  }
  throw new Error('JPEG without image data')
}

/** A minimal EXIF APP1 that carries only the orientation tag. */
function orientationExif(orientation: number): Buffer {
  const tiff = Buffer.alloc(26)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4) // IFD0 offset
  tiff.writeUInt16BE(1, 8) // one entry
  tiff.writeUInt16BE(0x0112, 10) // Orientation
  tiff.writeUInt16BE(3, 12) // SHORT
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt16BE(orientation, 18)
  tiff.writeUInt32BE(0, 22) // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xffe1, 0)
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

export function stripPng(input: Buffer): Buffer {
  const parts: Buffer[] = [input.subarray(0, 8)]
  let i = 8
  while (i + 12 <= input.length) {
    const length = input.readUInt32BE(i)
    const type = input.subarray(i + 4, i + 8).toString('latin1')
    const chunk = input.subarray(i, i + 12 + length)
    if (!PNG_DROP.has(type)) parts.push(chunk)
    i += 12 + length
    if (type === 'IEND') break
  }
  return Buffer.concat(parts)
}

async function describeVideo(
  name: string,
  file: string,
  paths: ToolPaths,
  signal: AbortSignal | undefined,
): Promise<OutputFile> {
  const [sha256, s, p] = await Promise.all([
    sha256File(file, signal),
    stat(file),
    probeVideo(file, { paths, signal }),
  ])
  return {
    name,
    path: file,
    sha256,
    bytes: s.size,
    mime: name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
    width: p.video.displayWidth,
    height: p.video.displayHeight,
    durationMs: p.durationMs,
  }
}
