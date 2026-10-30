import type {
  HubFile,
  HubPostFacts,
  Platform,
  PostSurface,
  ReceiptEntry,
  RowFacts,
  RowFile,
} from './load'
import { nameCore, sameSize } from './names'
import type { AdMarkers } from './settings'

/**
 * The rules of matching (SPEC §7 «Правила сопоставления», V2/V3 of 30.10.2026) as pure
 * functions over what `load.ts` read: no database here, every rule has its unit.
 */

/** OnlyFans gives whole seconds: its tolerance of duration is one second (SPEC §7). */
export const ONLYFANS_DURATION_MS = 1_000
/** «Существенное расхождение» of a confirmed pair or a candidate shown as «не совпадает». */
export const MISMATCH_MS = 1_000

export interface FileMatch {
  strength: 'exact' | 'none'
  versionId: string | null
  assetId: string | null
  itemId: string | null
  receiptEntryId: string | null
  /** Length of the issued file: «0:09 = 0:09». */
  issuedMs: number | null
  /** The name is ours, but no issued file of it matches by size and duration. */
  nameOnly: boolean
}

const NONE: FileMatch = {
  strength: 'none',
  versionId: null,
  assetId: null,
  itemId: null,
  receiptEntryId: null,
  issuedMs: null,
  nameOnly: false,
}

/**
 * Exact by Hub (SPEC §7): the name of the platform file reads as a download name, an issued file
 * of that name exists, its size matches without rotation and a video's duration is within
 * `hub_exact_duration_ms` (no value — no exact for video). Only `main` rows: a preview carries
 * the name of its main file and gives no exact (V2 № 3). OnlyFans gives no names.
 */
export function fileExact(
  file: Pick<HubFile, 'filename' | 'isVideo' | 'durationMs' | 'width' | 'height'> & {
    role?: HubFile['role']
  },
  receipts: ReadonlyMap<string, readonly ReceiptEntry[]>,
  durationMs: number | null,
  platform: Platform,
): FileMatch {
  if (platform !== 'fansly' || (file.role && file.role !== 'main')) return NONE
  const core = nameCore(file.filename)
  if (!core) return NONE
  const issued = receipts.get(core.key) ?? []
  if (issued.length === 0) return { ...NONE, nameOnly: true }
  for (const entry of issued) {
    if (sameSize(file, entry) !== true) continue
    if (file.isVideo) {
      if (durationMs === null || file.durationMs === null || entry.durationMs === null) continue
      if (Math.abs(file.durationMs - entry.durationMs) > durationMs) continue
    }
    return {
      strength: 'exact',
      versionId: entry.versionId,
      assetId: entry.assetId,
      itemId: entry.itemId,
      receiptEntryId: entry.id,
      issuedMs: entry.durationMs,
      nameOnly: false,
    }
  }
  return { ...NONE, nameOnly: true }
}

/**
 * The surface Hub proves (SPEC §7 «Поверхность», V3): For You views — FYP; flag 4 or no video
 * in files and previews — the wall; otherwise unknown (the plan, the KM or «уточнить»).
 */
export function hubSurface(
  post: Pick<HubPostFacts, 'forYouViews' | 'fypFlags' | 'hasVideo'>,
  platform: Platform,
): PostSurface | null {
  if (platform === 'onlyfans') return 'wall'
  if (post.forYouViews > 0) return 'fyp'
  if (post.fypFlags === 4 || !post.hasVideo) return 'wall'
  return null
}

/**
 * The surface a post without a proven one is shown and kept on (schema §9.6 `hub_hint`): a single
 * video without a preview is how FYP posts look (V3: 203 of 206), anything else the wall.
 */
export function hintSurface(post: Pick<HubPostFacts, 'mains' | 'previews'>): PostSurface {
  const [only] = post.mains
  return post.mains.length === 1 && only?.isVideo && post.previews.length === 0 ? 'fyp' : 'wall'
}

/** Rows of this surface may be this post: a FYP post can also stand on the wall (V3 № 29). */
export function surfaceFits(rowSurface: PostSurface, proven: PostSurface | null): boolean {
  if (proven === null) return true
  if (proven === 'fyp') return true
  return rowSurface === 'wall'
}

/** Minutes from the slot to the post, signed. */
export function offsetMinutes(row: Pick<RowFacts, 'slotAt'>, publishedAt: string): number {
  return (Date.parse(publishedAt) - Date.parse(row.slotAt)) / 60_000
}

/**
 * The time of a post fits the row: ± `hub_candidate_tolerance` of the slot, the whole local
 * day for a row without time (SPEC §7). No tolerance — only rows without time match.
 */
export function inWindow(
  row: Pick<RowFacts, 'slotAt' | 'slotTime' | 'dayStart' | 'dayEnd'>,
  publishedAt: string,
  toleranceMin: number | null,
): boolean {
  const at = Date.parse(publishedAt)
  if (!row.slotTime) return at >= Date.parse(row.dayStart) && at < Date.parse(row.dayEnd)
  if (toleranceMin === null) return false
  return Math.abs(offsetMinutes(row, publishedAt)) <= toleranceMin
}

/** Same local day, outside the window: a hint next to the row, nothing written (SPEC §7). */
export function sameDay(row: Pick<RowFacts, 'dayStart' | 'dayEnd'>, publishedAt: string): boolean {
  const at = Date.parse(publishedAt)
  return at >= Date.parse(row.dayStart) && at < Date.parse(row.dayEnd)
}

/**
 * The count of main files (SPEC §7, V2): one file — only a post of one file; a bundle — a post of
 * several, equal or one apart («в посте 17 файлов из 18»).
 */
export function countFits(rowFiles: number, postFiles: number): boolean {
  if (rowFiles <= 0 || postFiles <= 0) return false
  if (rowFiles === 1) return postFiles === 1
  return postFiles >= 2 && Math.abs(postFiles - rowFiles) <= 1
}

function durationsOf(files: readonly { isVideo: boolean; durationMs: number | null }[]): number[] {
  return files
    .filter((file) => file.isVideo && file.durationMs !== null)
    .map((file) => file.durationMs as number)
    .sort((left, right) => left - right)
}

/** Videos of both sides one to one within the tolerance; `null` — nothing to compare. */
export function durationsFit(
  ours: readonly RowFile[],
  theirs: readonly HubFile[],
  toleranceMs: number,
): { fits: boolean; ours: number; theirs: number } | null {
  const left = durationsOf(ours)
  const right = durationsOf(theirs)
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return null
  for (const [index, value] of left.entries()) {
    const other = right[index] as number
    if (Math.abs(value - other) > toleranceMs) return { fits: false, ours: value, theirs: other }
  }
  return { fits: true, ours: left[0] as number, theirs: right[0] as number }
}

/** Sizes of the files Hub gives match some file of the row; `null` — Hub gives none. */
export function sizesFit(ours: readonly RowFile[], theirs: readonly HubFile[]): boolean | null {
  const known = theirs.filter((file) => file.width && file.height)
  if (known.length === 0) return null
  return known.every((file) => ours.some((mine) => sameSize(mine, file) === true))
}

export type PairKind = 'exact' | 'reused' | 'partial' | 'mismatch' | 'candidate'

export interface PairJudgement {
  kind: PairKind
  /** Files of the post matched exactly to versions of the row. */
  matched: number
  rowFiles: number
  postFiles: number
  duration: { ours: number; theirs: number } | null
}

/**
 * What a row and a post in its window are to each other (SPEC §7): exact when every main file is
 * exact (or a confirmed pair) and the versions are the row's; «совпало k из n» when only some
 * are; a candidate by count; a visible mismatch when the video lengths differ. `null` — not a
 * pair: the count does not fit, or a file of the post is exactly another object's.
 */
export function judgePair(
  row: Pick<RowFacts, 'mains' | 'itemId'>,
  post: Pick<HubPostFacts, 'mains'>,
  exact: ReadonlyMap<string, FileMatch>,
  reused: ReadonlyMap<string, { versionId: string; assetId: string }>,
  platform: Platform,
): PairJudgement | null {
  const rowVersions = new Set(row.mains.map((file) => file.versionId))
  const rowAssets = new Set(row.mains.map((file) => file.assetId))
  const n = row.mains.length
  const m = post.mains.length
  let byName = 0
  let byPair = 0
  for (const file of post.mains) {
    const match = exact.get(file.attachmentId)
    if (match?.strength === 'exact') {
      // A file that is exactly another object's: this post is not this row.
      if (match.itemId !== row.itemId && !rowAssets.has(match.assetId ?? '')) return null
      if (match.versionId && rowVersions.has(match.versionId)) byName += 1
      continue
    }
    const pair = file.mediaRef ? reused.get(file.mediaRef) : undefined
    if (pair) {
      if (!rowAssets.has(pair.assetId)) return null
      if (rowVersions.has(pair.versionId)) byPair += 1
    }
  }
  const base = { rowFiles: n, postFiles: m }
  if (n > 0 && m === n && byName === n)
    return { kind: 'exact', matched: n, ...base, duration: null }
  if (n > 0 && m === n && byName + byPair === n && byPair > 0) {
    return { kind: 'reused', matched: n, ...base, duration: null }
  }
  if (!countFits(n, m)) return null
  if (platform === 'onlyfans' && sizesFit(row.mains, post.mains) === false) return null
  const tolerance = platform === 'onlyfans' ? ONLYFANS_DURATION_MS : MISMATCH_MS
  const duration = durationsFit(row.mains, post.mains, tolerance)
  if (duration && !duration.fits) {
    return { kind: 'mismatch', matched: byName, ...base, duration }
  }
  const shown = duration ? { ours: duration.ours, theirs: duration.theirs } : null
  if (byName > 0) return { kind: 'partial', matched: byName, ...base, duration: shown }
  return { kind: 'candidate', matched: 0, ...base, duration: shown }
}

/**
 * Fansly only, one to one, time and duration within tolerance, equal count (SPEC §7 «Массовое
 * подтверждение»): such a pair may be confirmed together with others after the list is seen.
 */
export function isUnambiguous(input: {
  platform: Platform
  kind: PairKind
  variants: number
  rowsOfPost: number
  offsetMin: number
  toleranceMin: number | null
  rowFiles: number
  postFiles: number
  ours: readonly RowFile[]
  theirs: readonly HubFile[]
  durationMs: number | null
}): boolean {
  if (input.platform !== 'fansly') return false
  if (input.kind !== 'candidate') return false
  if (input.variants !== 1 || input.rowsOfPost !== 1) return false
  if (input.rowFiles !== input.postFiles) return false
  if (input.toleranceMin !== null && Math.abs(input.offsetMin) > input.toleranceMin) return false
  const videos =
    input.ours.some((file) => file.isVideo) || input.theirs.some((file) => file.isVideo)
  if (!videos) return true
  if (input.durationMs === null) return false
  const fit = durationsFit(input.ours, input.theirs, input.durationMs)
  return fit?.fits === true
}

/**
 * An ad of another page without plan (SPEC §7): a marker tag or a foreign `@handle` in the
 * caption, and no file of the model by duration and size (`hasModelFile`).
 */
export function looksLikeAd(caption: string | null, markers: AdMarkers | null): boolean {
  if (!markers || !caption) return false
  const text = caption.toLowerCase()
  if (markers.tags.some((tag) => text.includes(tag))) return true
  const handles = [...text.matchAll(/@([a-z0-9_.]+)/g)].map((match) => match[1] as string)
  return handles.some((handle) => !markers.ownHandles.includes(handle))
}

/** The composition of files in words: «видео 0:09», «видео 9:41 и 2 фото», «22 фото». */
export function summaryOf(
  files: readonly { isVideo: boolean; durationMs: number | null }[],
): string {
  const videos = files.filter((file) => file.isVideo)
  const photos = files.length - videos.length
  const clock = (ms: number | null) => {
    if (ms === null) return ''
    const total = Math.round(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = String(total % 60).padStart(2, '0')
    return h > 0 ? ` ${h}:${String(m).padStart(2, '0')}:${s}` : ` ${m}:${s}`
  }
  const parts: string[] = []
  if (videos.length === 1) parts.push(`видео${clock(videos[0]?.durationMs ?? null)}`)
  else if (videos.length > 1) parts.push(`${videos.length} видео`)
  if (photos > 0) parts.push(`${photos} фото`)
  return parts.join(' и ') || 'без файлов'
}

/**
 * Versions to the files of a post, one to one, for a confirmed pair (SPEC §7: «пара версия —
 * аккаунт и media ID»): exact names first, then videos by the nearest length, photos by size,
 * the rest in order.
 */
export function pairFiles(
  ours: readonly RowFile[],
  theirs: readonly HubFile[],
  exact: ReadonlyMap<string, FileMatch>,
): { version: RowFile; file: HubFile }[] {
  const left = [...ours]
  const out: { version: RowFile; file: HubFile }[] = []
  const take = (file: HubFile, pick: (version: RowFile) => boolean) => {
    const index = left.findIndex(pick)
    if (index < 0) return false
    out.push({ version: left[index] as RowFile, file })
    left.splice(index, 1)
    return true
  }
  const rest: HubFile[] = []
  for (const file of theirs) {
    const match = exact.get(file.attachmentId)
    if (match?.versionId && take(file, (version) => version.versionId === match.versionId)) continue
    rest.push(file)
  }
  const unsized: HubFile[] = []
  for (const file of rest) {
    if (file.isVideo && file.durationMs !== null) {
      const videos = left.filter((version) => version.isVideo && version.durationMs !== null)
      const nearest = videos.sort(
        (a, b) =>
          Math.abs((a.durationMs as number) - (file.durationMs as number)) -
          Math.abs((b.durationMs as number) - (file.durationMs as number)),
      )[0]
      if (nearest && take(file, (version) => version === nearest)) continue
    } else if (
      !file.isVideo &&
      take(file, (version) => !version.isVideo && sameSize(version, file) === true)
    ) {
      continue
    }
    unsized.push(file)
  }
  for (const file of unsized) take(file, (version) => version.isVideo === file.isVideo)
  return out
}
