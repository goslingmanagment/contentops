import { writeFile } from 'node:fs/promises'
import { removeQuietly, tempPathIn } from './files.ts'
import { HLG_SDR_LUT } from './hlg-sdr-lut.ts'
import type { VideoProbe, VideoStream } from './probe.ts'
import { sha256Hex } from './recipe.ts'

/**
 * HDR → SDR of what people download and fans see (SPEC §9.3, compression.md §10.12):
 * `platform.mp4`, uniq versions, the compatible copy and a frame taken as a photo. Previews and
 * stills stay on `HDR_TO_SDR`: their recipe drives rebuilds of the whole library.
 *
 * - HLG (every HDR file of the library) goes through a 3D table measured from Apple's conversion.
 * - PQ, none in the library yet: `tonemap`, the closest cheap chain to Apple's PQ conversion.
 * - Dolby Vision on an SDR base (`bt709` transfer) is shown as its base. A base without a transfer
 *   tag is taken for PQ, so that a surprise never stops a build.
 */

export type HdrSignal = 'hlg' | 'pq' | 'sdr'

export function hdrSignalOf(video: Pick<VideoStream, 'colorTransfer'>): HdrSignal {
  switch (video.colorTransfer) {
    case 'arib-std-b67':
      return 'hlg'
    case null:
    case 'smpte2084':
    case 'unknown':
      return 'pq'
    default:
      return 'sdr'
  }
}

/**
 * HLG Y'CbCr → R'G'B' → the table → BT.709 Y'CbCr. Matrix and primaries are taken as BT.2020 (a file
 * without the tags still builds); the range is the source's. The table turns the signal, the tags
 * follow it.
 */
export function hlgToSdr(lutPath: string): string {
  return [
    'zscale=min=2020_ncl:pin=2020:tin=arib-std-b67:t=arib-std-b67:p=2020:r=pc',
    'format=gbrp16le',
    `lut3d=file=${filterPath(lutPath)}:interp=tetrahedral`,
    'setparams=range=pc:color_primaries=bt709:color_trc=bt709',
    'zscale=m=709:t=bt709:p=bt709:r=tv',
    'format=yuv420p',
  ].join(',')
}

export const PQ_TO_SDR = [
  'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
  'zscale=t=linear:npl=203',
  'format=gbrpf32le',
  'zscale=p=bt709',
  'tonemap=tonemap=mobius:desat=0:peak=4.926',
  'zscale=t=bt709:m=bt709:r=tv',
  'format=yuv420p',
].join(',')

/** A path as a value of a filter option inside a filter graph: both levels of FFmpeg's escaping. */
export function filterPath(path: string): string {
  const option = path.replace(/[\\':]/g, '\\$&')
  return option.replace(/[\\'[\],;]/g, '\\$&')
}

let cube: string | undefined

/** The table as a `.cube` file for `lut3d`. */
export function hlgSdrCube(): string {
  if (cube === undefined) {
    const { points, values } = HLG_SDR_LUT
    const lines = [`LUT_3D_SIZE ${points}`]
    const unit = (at: number) => (Number.parseInt(values.slice(at, at + 3), 16) / 4095).toFixed(5)
    for (let at = 0; at < values.length; at += 9) {
      lines.push(`${unit(at)} ${unit(at + 3)} ${unit(at + 6)}`)
    }
    cube = `${lines.join('\n')}\n`
  }
  return cube
}

/** What goes into the recipes of copies from HDR sources: a new table is a new recipe. */
export function copyHdrRecipe() {
  return {
    hlg: hlgToSdr('<table>'),
    pq: PQ_TO_SDR,
    table: { points: HLG_SDR_LUT.points, sha256: sha256Hex(hlgSdrCube()) },
  }
}

/**
 * The `hdr` member of a recipe: the conversion of an HDR source, or `old` (`HDR_TO_SDR`, never
 * applied to SDR) for an SDR one, so that recipes of SDR sources and their digests stay as they
 * were.
 */
export function hdrOfRecipe<T>(hdrSource: boolean, old: T) {
  return hdrSource ? copyHdrRecipe() : old
}

/**
 * Runs a build with the HDR filter of its source (`null` for SDR). The table of HLG lies in
 * `dir` (next to the output) for the time of the build.
 */
export async function withHdrFilter<T>(
  probe: VideoProbe,
  dir: string,
  build: (hdr: string | null) => Promise<T>,
): Promise<T> {
  const signal = probe.video.isHdr ? hdrSignalOf(probe.video) : 'sdr'
  if (signal === 'sdr') return build(null)
  if (signal === 'pq') return build(PQ_TO_SDR)
  const lut = tempPathIn(dir, 'hlg-sdr', '.cube')
  try {
    await writeFile(lut, hlgSdrCube())
    return await build(hlgToSdr(lut))
  } finally {
    await removeQuietly(lut)
  }
}
