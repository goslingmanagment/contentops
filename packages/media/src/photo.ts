import { mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import exifr from 'exifr'
import sharp from 'sharp'
import phash from 'sharp-phash'
import type { Artifact } from './derive-video.ts'
import { removeQuietly, Scratch, sha256File, tempPathIn } from './files.ts'
import { type Camera, parseZoned, type ShotTime, UnreadableMediaError } from './probe.ts'
import { type DigestedRecipe, digested, recipe } from './recipe.ts'
import {
  abortAware,
  detectToolVersions,
  MediaAbortError,
  type ToolVersions,
  throwIfAborted,
} from './tools.ts'

/**
 * Photo job (SPEC §9.3, §12.0 «Фото»): one idempotent pass — EXIF and orientation → preview
 * → thumbnails → frame for annotation → pHash. sharp runs on the system libvips with
 * libheif + libde265; the source (HEIC included) is only read.
 */

export type PhotoDerivativeKind = 'preview2048' | 'thumb320' | 'thumb640' | 'frames'
export const PHOTO_DERIVATIVE_KINDS: readonly PhotoDerivativeKind[] = [
  'preview2048',
  'thumb320',
  'thumb640',
  'frames',
]

export const PHOTO_PROFILE = {
  /** Orientation applied, embedded ICC converted to sRGB, then dropped (sharp default). */
  normalize: { orientation: 'applied', colour: 'srgb', icc: 'removed', kernel: 'lanczos3' },
  /** Everything below is cut from one ≤2048 px intermediate. */
  intermediate: 2048,
  preview2048: { longSide: 2048, quality: 85, name: 'preview-2048.webp' },
  thumb640: { longSide: 640, quality: 80, name: 'thumb-640.webp' },
  thumb320: { longSide: 320, quality: 80, name: 'thumb-320.webp' },
  /** The annotation frame of a photo: one 512 px still, moment 0. */
  frame: { longSide: 512, quality: 80, name: 'frames/0000.webp' },
  webpEffort: 4,
} as const

/** `blob_phashes (algorithm, algo_version, normalization)`. */
export const PHASH_PROFILE = {
  algorithm: 'dct64-sharp-phash',
  normalization: 'orient+srgb+fit2048+fit512-lanczos3+png',
} as const

export interface PhotoProbe extends ShotTime {
  kind: 'photo'
  format: string
  /** As displayed: orientation applied. */
  width: number
  height: number
  /** As stored. */
  codedWidth: number
  codedHeight: number
  /** EXIF orientation 1–8 as libvips reports it (HEIF transforms are already applied). */
  orientation: number
  /** Clockwise degrees implied by the orientation. */
  rotation: number
  space: string | null
  bitDepth: number | null
  hasAlpha: boolean
  hasIcc: boolean
  pages: number
  camera: Camera | null
  /** Selected EXIF fields, JSON-safe. */
  exif: Record<string, string | number | null>
}

export interface PhotoHash {
  algorithm: string
  algoVersion: string
  normalization: string
  /** 64 bits as `0`/`1` (Postgres `bit(64)` literal). */
  bits: string
  hex: string
}

export interface PhotoResult {
  probe: PhotoProbe
  artifacts: Artifact[]
  phash: PhotoHash
  recipes: Partial<Record<PhotoDerivativeKind | 'phash' | 'probe', DigestedRecipe>>
  totalMs: number
}

export interface PhotoOptions {
  input: string
  /** Finished files go here under manifest names; failure or abort leaves nothing. */
  outDir: string
  kinds?: readonly PhotoDerivativeKind[]
  signal?: AbortSignal
  versions?: ToolVersions
}

const PHOTO_TOOLS = ['libvips', 'sharp', 'libheif', 'libde265', 'libwebp'] as const

export function photoRecipes(
  versions: ToolVersions,
): Record<PhotoDerivativeKind | 'phash' | 'probe', DigestedRecipe> {
  const p = PHOTO_PROFILE
  const common = { normalize: p.normalize, intermediate: p.intermediate, webpEffort: p.webpEffort }
  const r = (kind: PhotoDerivativeKind, own: object) =>
    digested(recipe(kind, 'photo', { ...common, ...own }, versions, PHOTO_TOOLS))
  return {
    preview2048: r('preview2048', p.preview2048),
    thumb640: r('thumb640', p.thumb640),
    thumb320: r('thumb320', p.thumb320),
    frames: r('frames', p.frame),
    phash: digested(
      recipe('phash', 'photo', { ...PHASH_PROFILE, ...common }, versions, [
        ...PHOTO_TOOLS,
        'phash',
      ]),
    ),
    probe: digested(
      recipe('probe', 'photo', { reader: 'sharp.metadata+exifr', parser: 1 }, versions, [
        'libvips',
        'sharp',
        'libheif',
      ]),
    ),
  }
}

const ORIENTATION_ROTATION: Record<number, number> = {
  3: 180,
  4: 180,
  5: 90,
  6: 90,
  7: 270,
  8: 270,
}

export async function probePhoto(input: string): Promise<PhotoProbe> {
  const meta = await sharp(input).metadata()
  const orientation = meta.orientation ?? 1
  const turned = orientation >= 5
  const codedWidth = meta.width ?? 0
  const codedHeight = meta.height ?? 0
  const exif = await readExif(meta.exif)
  return {
    kind: 'photo',
    format: meta.format ?? 'unknown',
    width: turned ? codedHeight : codedWidth,
    height: turned ? codedWidth : codedHeight,
    codedWidth,
    codedHeight,
    orientation,
    rotation: ORIENTATION_ROTATION[orientation] ?? 0,
    space: meta.space ?? null,
    bitDepth: depthBits(meta.depth),
    hasAlpha: meta.hasAlpha ?? false,
    hasIcc: Boolean(meta.icc),
    pages: meta.pages ?? 1,
    ...photoShotTime(exif),
    camera:
      exif.Make || exif.Model || exif.Software
        ? {
            make: str(exif.Make),
            model: str(exif.Model),
            software: str(exif.Software),
          }
        : null,
    exif,
  }
}

const EXIF_FIELDS = [
  'Make',
  'Model',
  'Software',
  'LensModel',
  'DateTimeOriginal',
  'OffsetTimeOriginal',
  'CreateDate',
  'OffsetTime',
  'Orientation',
] as const

/**
 * EXIF from the block libvips extracted (`metadata().exif`): one path for JPEG, HEIC, PNG
 * and WebP. exifr reads it as TIFF; it cannot parse the Exif item libheif writes.
 */
async function readExif(
  block: Buffer | undefined,
): Promise<Record<string, string | number | null>> {
  if (!block || block.length < 8) return {}
  const tiff = block.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? block.subarray(6) : block
  try {
    const data = (await exifr.parse(tiff, {
      pick: [...EXIF_FIELDS],
      reviveValues: false,
      translateValues: false,
    })) as Record<string, unknown> | undefined
    const out: Record<string, string | number | null> = {}
    for (const key of EXIF_FIELDS) {
      const v = data?.[key]
      if (typeof v === 'string') out[key] = v.replace(/\0+$/, '').trim()
      else if (typeof v === 'number') out[key] = v
    }
    return out
  } catch {
    return {}
  }
}

/** EXIF `2024:01:02 03:04:05` with `OffsetTimeOriginal`; without a zone only the wall clock. */
export function photoShotTime(exif: Record<string, string | number | null>): ShotTime {
  const raw = str(exif.DateTimeOriginal) ?? str(exif.CreateDate)
  const m = raw ? /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw) : null
  if (!m) return { shotAt: null, shotAtLocal: null, shotTz: null }
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  const offset = str(raw === str(exif.DateTimeOriginal) ? exif.OffsetTimeOriginal : exif.OffsetTime)
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset)) {
    return parseZoned(`${local}${offset}`) ?? { shotAt: null, shotAtLocal: local, shotTz: null }
  }
  return { shotAt: null, shotAtLocal: local, shotTz: null }
}

function str(v: string | number | null | undefined): string | null {
  return typeof v === 'string' && v ? v : null
}

function depthBits(depth: string | undefined): number | null {
  switch (depth) {
    case 'uchar':
    case 'char':
      return 8
    case 'ushort':
    case 'short':
      return 16
    case 'float':
      return 32
    default:
      return null
  }
}

export async function processPhoto(options: PhotoOptions): Promise<PhotoResult> {
  const started = performance.now()
  const signal = options.signal
  const kinds = options.kinds ?? PHOTO_DERIVATIVE_KINDS
  const versions = options.versions ?? (await detectToolVersions({ signal }))
  const recipes = photoRecipes(versions)
  throwIfAborted(signal)
  // One decode: oriented, sRGB, ≤2048 px — every output is cut from it. A file libvips cannot
  // decode is unreadable and waits for a replacement, as a video would (SPEC §9.2).
  const p = PHOTO_PROFILE
  let probe: PhotoProbe
  let decoded: { data: Buffer; info: sharp.OutputInfo }
  try {
    probe = await probePhoto(options.input)
    throwIfAborted(signal)
    decoded = await sharp(options.input, { failOn: 'error' })
      .rotate()
      .resize(p.intermediate, p.intermediate, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    if (signal?.aborted) throw new MediaAbortError()
    throw new UnreadableMediaError(
      `cannot decode ${options.input}`,
      String((error as Error).message ?? error),
    )
  }
  const { data, info } = decoded
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } } as const
  const fit = (side: number) =>
    sharp(data, raw).resize(side, side, { fit: 'inside', withoutEnlargement: true })
  throwIfAborted(signal)

  await mkdir(options.outDir, { recursive: true })
  const scratch = new Scratch()
  const workDir = scratch.track(tempPathIn(options.outDir, 'photo', ''))
  try {
    await mkdir(workDir)
    const frame512 = await fit(p.frame.longSide).png().toBuffer()
    const bits = await phash(frame512)
    const outputs: { kind: PhotoDerivativeKind; name: string; make: () => sharp.Sharp }[] = []
    const want = new Set(kinds)
    if (want.has('preview2048')) {
      outputs.push({
        kind: 'preview2048',
        name: p.preview2048.name,
        make: () => sharp(data, raw).webp({ quality: p.preview2048.quality, effort: p.webpEffort }),
      })
    }
    for (const k of ['thumb640', 'thumb320'] as const) {
      if (!want.has(k)) continue
      outputs.push({
        kind: k,
        name: p[k].name,
        make: () => fit(p[k].longSide).webp({ quality: p[k].quality, effort: p.webpEffort }),
      })
    }
    if (want.has('frames')) {
      outputs.push({
        kind: 'frames',
        name: p.frame.name,
        make: () => sharp(frame512).webp({ quality: p.frame.quality, effort: p.webpEffort }),
      })
    }
    const artifacts: Artifact[] = []
    for (const o of outputs) {
      throwIfAborted(signal)
      const file = join(workDir, o.name)
      await mkdir(dirname(file), { recursive: true })
      const out = await o.make().toFile(file)
      const [sha256, s] = await Promise.all([sha256File(file, signal), stat(file)])
      artifacts.push({
        kind: o.kind,
        name: o.name,
        path: file,
        sha256,
        bytes: s.size,
        mime: 'image/webp',
        width: out.width,
        height: out.height,
        durationMs: null,
        frameMs: o.kind === 'frames' ? 0 : null,
      })
    }
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
      for (const f of published) await removeQuietly(f)
      throw error
    }
    await scratch.cleanup()
    const picked: PhotoResult['recipes'] = { phash: recipes.phash, probe: recipes.probe }
    for (const k of kinds) picked[k] = recipes[k]
    return {
      probe,
      artifacts,
      phash: {
        algorithm: PHASH_PROFILE.algorithm,
        algoVersion: versions.phash,
        normalization: PHASH_PROFILE.normalization,
        bits,
        hex: BigInt(`0b${bits}`).toString(16).padStart(16, '0'),
      },
      recipes: picked,
      totalMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    await scratch.cleanup()
    throw abortAware(error, signal)
  }
}

/** Hamming distance of two 64-bit hashes (`bits` strings). */
export function phashDistance(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) d++
  return d
}

/**
 * libvips pool knobs for `worker-image` (SPEC §12.0: `sharp.concurrency(4)` and a bounded
 * cache as starting values until measured).
 */
export function configureImagePool(options: { concurrency?: number; cacheMemoryMb?: number } = {}) {
  sharp.concurrency(options.concurrency ?? 4)
  sharp.cache({ memory: options.cacheMemoryMb ?? 256, files: 0, items: 100 })
  return imagePoolStats()
}

export function imagePoolStats() {
  return { concurrency: sharp.concurrency(), cache: sharp.cache(), counters: sharp.counters() }
}
