import type { values } from '@contentops/db'

/**
 * Grouping of discovered files into intake groups (SPEC §6.1). Pure rules; the database part
 * (finding an open upload cluster, folder ids) is in `discover.ts`.
 *
 * Paths are relative to the model's folder at the source. Its first-level folders are the
 * roots (`1. PPV`, `3. Customs`, `BG`, …). A file inside a subfolder of a root belongs to the
 * group of that subfolder, held by its folder id, not by its path. A file right in a root (or
 * in the model's folder itself) is grouped by its EXIF day, without EXIF by a cluster of up to
 * 45 minutes from the first file. One object is one clip, as in the import of the old disk
 * (`legacy/units.ts`): a video under `2. FYP` or `3. Customs` is a group by itself at any depth,
 * a loose video in `BG` too; a folder of FYP sources (`2. FYP/FYP исходники`) is one shoot.
 */

export const UPLOAD_CLUSTER_MS = 45 * 60 * 1000

const FYP_ROOT = /fyp|фуп/i
const CUSTOM_ROOT = /customs?|кастом/i
const BG_ROOT = /^bg$/i

/** A folder of clips a FYP is made from: its files are raw material, not ready FYPs. */
const FYP_SOURCES = /исходник|сырь[её]|оригинал|\bsources?\b|\braw\b|\boriginals?\b/i

export type Placement =
  /** The file is an object by itself, whatever folder it lies in. */
  | { kind: 'single' }
  /** Inside the folder made of the first `folderDepth` components of `relative`. */
  | { kind: 'folder'; folderDepth: number; proposal?: FolderProposal }
  /** Right in a root (`folderDepth` 1) or in the model's folder itself (0). */
  | { kind: 'root'; folderDepth: 0 | 1 }

/** What the kind of a folder says about its future object, above what its root says. */
export interface FolderProposal {
  type: values.ContentType
  purpose: values.RawPurpose
}

/** `relative` — path components of the file, its name last. */
export function placementOf(relative: readonly string[], isVideo: boolean): Placement {
  const dirs = relative.length - 1
  const root = dirs >= 1 ? (relative[0] ?? '') : ''
  if (FYP_ROOT.test(root)) {
    const sources = relative.slice(1, -1).findIndex((name) => FYP_SOURCES.test(name))
    if (sources >= 0) {
      return { kind: 'folder', folderDepth: sources + 2, proposal: { type: 'RAW', purpose: 'fyp' } }
    }
  }
  if (isVideo && (FYP_ROOT.test(root) || CUSTOM_ROOT.test(root))) return { kind: 'single' }
  if (dirs >= 2) return { kind: 'folder', folderDepth: 2 }
  if (isVideo && BG_ROOT.test(root)) return { kind: 'single' }
  return { kind: 'root', folderDepth: dirs <= 0 ? 0 : 1 }
}

export interface LooseFile {
  fileId: string
  isVideo: boolean
  /** EXIF time from the source, ISO. */
  shotAt: string | null
  /** Root folder name (`3. Customs`); `null` in the model's folder itself. */
  rootName: string | null
}

export type LooseGroup =
  | { grouping: 'single'; key: string }
  | { grouping: 'exif_day'; key: string; day: string }
  /** The caller finds an open cluster of this folder or starts one at the file's time. */
  | { grouping: 'upload_cluster'; prefix: string }

/** Roots whose loose videos are objects one by one in the old disk's units too (SPEC §6.1). */
const ONE_BY_ONE_ROOTS = [CUSTOM_ROOT, BG_ROOT]

/**
 * Group of a file right in a root: by itself, by EXIF day, or by an upload cluster. Used by the
 * import of the old disk as well, which takes FYPs one by one by its own parse.
 */
export function looseGroupOf(file: LooseFile, folderId: string, timezone: string): LooseGroup {
  if (
    file.isVideo &&
    file.rootName &&
    ONE_BY_ONE_ROOTS.some((re) => re.test(file.rootName ?? ''))
  ) {
    return { grouping: 'single', key: `single:${file.fileId}` }
  }
  if (file.shotAt) {
    const day = localDay(file.shotAt, timezone)
    return { grouping: 'exif_day', key: `exif-day:${folderId}:${day}`, day }
  }
  return { grouping: 'upload_cluster', prefix: `upload-window:${folderId}:` }
}

/** `upload-window:<folder>:<start ISO>` → the start; null for another key. */
export function clusterStart(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) return null
  const at = Date.parse(key.slice(prefix.length))
  return Number.isNaN(at) ? null : at
}

/** The window the file falls into: `[start, start + 45 min)`, no chains (SPEC §6.1). */
export function fitsCluster(start: number, at: number): boolean {
  return at >= start && at < start + UPLOAD_CLUSTER_MS
}

/** `YYYY-MM-DD` of an instant in the model's time zone. */
export function localDay(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

const TYPE_BY_ROOT: [RegExp, values.ContentType][] = [
  [/ppv|bundle|бандл/i, 'PPV'],
  [/custom|кастом/i, 'CUS'],
  [/sext|секст/i, 'SXT'],
  [/\bsets?\b|сеты?\b|фотосет/i, 'SET'],
  [/life|лайф/i, 'LIFE'],
  [/fyp|фуп/i, 'FYP'],
  [/smm|\braw\b|сырь/i, 'RAW'],
]

/** Type of the future object from the root it came through (DESIGN §1.4: «из корня»). */
export function typeFromRoot(rootName: string | null): values.ContentType | null {
  if (!rootName) return null
  return TYPE_BY_ROOT.find(([re]) => re.test(rootName))?.[1] ?? null
}

/**
 * The type a file proposes through its root. A FYP is one clip: photos in `2. FYP` say nothing
 * about what they are, so their group asks ◆ «Что это?» instead of a refusal at «Принять».
 */
export function typeOfFile(rootName: string | null, isVideo: boolean): values.ContentType | null {
  const type = typeFromRoot(rootName)
  return type === 'FYP' && !isVideo ? null : type
}

/** `13:03 вся в красном.mov` → `вся в красном`: the tail of a custom's name is its title. */
export function titleFromFileName(name: string, type: values.ContentType | null): string {
  const dot = name.lastIndexOf('.')
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim()
  if (type !== 'CUS') return stem
  const tail = stem.replace(/^\d{1,3}[:.]\d{2}\s*/, '').trim()
  return tail === '' ? stem : tail
}

const MEDIA_BY_EXT: Record<string, values.MediaKind> = {}
for (const ext of 'jpg jpeg png heic heif webp tif tiff dng gif'.split(' '))
  MEDIA_BY_EXT[ext] = 'image'
for (const ext of 'mp4 mov m4v avi mkv webm mts m2ts 3gp hevc'.split(' '))
  MEDIA_BY_EXT[ext] = 'video'

/**
 * macOS service files: anything under `__MACOSX/` of a zip and the AppleDouble twin `._name`
 * (a few hundred bytes of attributes next to every file copied from a Mac). Taken for photos
 * and videos by their extension, they failed the image and video works of an archive.
 */
function isMacServiceFile(name: string): boolean {
  const parts = name.split('/')
  return parts.includes('__MACOSX') || (parts.at(-1) ?? '').startsWith('._')
}

/** Photo or video by the source's media type, then by the extension; `null` — not media. */
export function mediaKindOf(name: string, mediaType: string | null): values.MediaKind | null {
  if (isMacServiceFile(name)) return null
  if (mediaType === 'image') return 'image'
  if (mediaType === 'video') return 'video'
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MEDIA_BY_EXT[ext] ?? null
}
