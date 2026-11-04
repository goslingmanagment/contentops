import type { values } from '@contentops/db'
import { areaOfSection, contextOf, type LegacyClaim, parseLegacyName } from '@contentops/legacy'

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
 * a loose video in `BG` too; a folder of FYP sources (`2. FYP/FYP исходники`) is one shoot. In
 * `9. SMM` the folder right above the files is the group, a collection of the channel its path
 * names (`9. SMM/Gif сайты/Октябрь/нюд`), as the import makes it (SPEC §6.3).
 *
 * A tree a Telegram mirror fills (Ари's Dropbox, legacy §10) is read by the rules of the import
 * of that archive, by the form of the tree and the names: a day folder `ДД.ММ.ГГ` deeper in a
 * root (`8. Other/личка/02.11.26`) is its own group; in `2. FYP` a day folder and the takes of a
 * task (`…/FYP 01 — …/Дубли`) are raw material for FYPs, a group per day or task; a clip of
 * `7. Монтажи` is a FYP by itself, a folder named by an ID there (`Агент/PPV-018`) holds copies
 * of that object's files; a pack (`PPV-018 Название`) names its number and title.
 */

export const UPLOAD_CLUSTER_MS = 45 * 60 * 1000

const FYP_ROOT = /fyp|фуп/i
const CUSTOM_ROOT = /customs?|кастом/i
const BG_ROOT = /^bg$/i
const SMM_ROOT = /(^|[^\p{L}])smm($|[^\p{L}])|смм/iu
/** `7. Монтажи` — ready clips of the editors (legacy §10): a clip is a FYP by itself. */
const MONTAGE_ROOT = /монтаж/i

/** A folder of clips a FYP is made from: its files are raw material, not ready FYPs. */
const FYP_SOURCES = /исходник|сырь[её]|оригинал|\bsources?\b|\braw\b|\boriginals?\b/i
/** A folder named by its day only: what a mirror put there that day (`01.11.26`). */
const DAY_FOLDER = /^\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4})$/u
/** `Дубли` — the takes a model shot for a FYP task: part of the task's group. */
const FYP_TAKES = /^дубли$/iu
/** A task of a cycle of FYP sources (`FYP 01 — Микрофлеш`): a group of its own. */
const FYP_TASK = /^FYP\s?\d{1,3}(?!\d)/iu
/** The ID alone (`PPV-018`): a folder that keeps copies of that object's files. */
const ID_FOLDER = /^(PPV|SET|SXT|SEX|CUS|FYP|LIFE|RAW|PRM)-(\d{3,6})$/iu

export type Placement =
  /** The file is an object by itself, whatever folder it lies in. */
  | { kind: 'single' }
  /** Inside the folder made of the first `folderDepth` components of `relative`. */
  | { kind: 'folder'; folderDepth: number; proposal?: FolderProposal }
  /** Right in a root (`folderDepth` 1) or in the model's folder itself (0). */
  | { kind: 'root'; folderDepth: 0 | 1 }

/** The number a folder's name gives its object: a pack, or a folder of its copies. */
export interface PackNumber {
  type: values.ContentType
  number: number
}

/** What the kind of a folder says about its future object, above what its root says. */
export interface FolderProposal {
  type: values.ContentType
  purpose: values.RawPurpose | null
  /**
   * Folders of the path that may name a promo channel, outermost first: the first one that is a
   * channel of the model makes the folder its collection; none — SMM without a channel is raw
   * material for FYPs, as the import of the old disk takes it.
   */
  channelFrom?: readonly string[]
  /** The title the folder's name gives (a pack's words after its ID); else the folder's name. */
  title?: string | null
  /** The number the folder's name claims (SPEC §6.4): kept at «Принять» while it is free. */
  pack?: PackNumber
}

/** `SEX` is Ари's word for SXT (legacy §10). */
function typeOfCode(code: string): values.ContentType {
  const upper = code.toUpperCase()
  return (upper === 'SEX' ? 'SXT' : upper) as values.ContentType
}

/**
 * A pack: a folder named by the ID without brackets in the section of its type (`1. PPV/PPV-018
 * Белая майка`, `5. Sextings/18.10.26 SXT-002 …`), read by the parser of the import (SPEC §6.3).
 */
export function packOf(
  rootName: string,
  folderName: string,
): (PackNumber & { title: string | null }) | null {
  const area = areaOfSection(rootName)
  if (!area) return null
  const claims = parseLegacyName(folderName, { isDir: true, area, subArea: area })
  const number = claims.find(
    (c): c is Extract<LegacyClaim, { kind: 'number' }> =>
      c.kind === 'number' && c.payload.form === 'pack',
  )
  if (!number) return null
  const title = claims.find((c) => c.kind === 'title')
  return {
    type: number.payload.type as values.ContentType,
    number: number.payload.number,
    title: title?.kind === 'title' ? title.payload.text : null,
  }
}

/** Raw material for FYPs, a group per day or task of `2. FYP`; `null` — not such a path. */
function fypRawDepth(folders: readonly string[]): number | null {
  const names = folders.map((name) => name.trim())
  const day = names.findIndex((name) => DAY_FOLDER.test(name))
  const takes = names.findIndex((name) => FYP_TAKES.test(name))
  // `Дубли` belongs to the task above it; right in the root it is a folder of its own.
  const takesDepth = takes < 0 ? null : takes === 0 ? 2 : takes + 1
  const dayDepth = day < 0 ? null : day + 2
  if (takesDepth === null) return dayDepth
  return dayDepth === null ? takesDepth : Math.min(takesDepth, dayDepth)
}

/** `relative` — path components of the file, its name last. */
export function placementOf(relative: readonly string[], isVideo: boolean): Placement {
  const dirs = relative.length - 1
  const root = dirs >= 1 ? (relative[0] ?? '') : ''
  const folders = relative.slice(1, -1)
  if (FYP_ROOT.test(root)) {
    // A day folder and the takes of a task: raw for FYPs, a group per day or task (SPEC §6.3).
    const raw = fypRawDepth(folders)
    if (raw !== null) {
      return { kind: 'folder', folderDepth: raw, proposal: { type: 'RAW', purpose: 'fyp' } }
    }
    const sources = folders.findIndex((name) => FYP_SOURCES.test(name))
    if (sources >= 0) {
      // A task of a cycle of sources (`FYP 01 — Микрофлеш`) is a group of its own.
      const task = folders.findIndex((name, i) => i > sources && FYP_TASK.test(name.trim()))
      const depth = task >= 0 ? task + 2 : sources + 2
      return { kind: 'folder', folderDepth: depth, proposal: { type: 'RAW', purpose: 'fyp' } }
    }
  }
  if (SMM_ROOT.test(root) && dirs >= 2) {
    const channelFrom = folders
    return {
      kind: 'folder',
      folderDepth: dirs,
      proposal: { type: 'PRM', purpose: null, channelFrom },
    }
  }
  if (MONTAGE_ROOT.test(root)) {
    // `Агент/PPV-018`: copies of the pack's files — its type and number, the same files again.
    const copies = folders.findIndex((name) => ID_FOLDER.test(name.trim()))
    const id = copies >= 0 ? ID_FOLDER.exec((folders[copies] ?? '').trim()) : null
    if (id) {
      const pack = { type: typeOfCode(id[1] ?? ''), number: Number(id[2]) }
      return {
        kind: 'folder',
        folderDepth: copies + 2,
        proposal: { type: pack.type, purpose: null, pack },
      }
    }
    if (isVideo) return { kind: 'single' }
  }
  if (isVideo && (FYP_ROOT.test(root) || CUSTOM_ROOT.test(root))) return { kind: 'single' }
  if (dirs >= 2) {
    // A day folder deeper in a root (`8. Other/личка/02.11.26`) is a group of its own.
    const day = folders.findIndex((name, i) => i >= 1 && DAY_FOLDER.test(name.trim()))
    if (day >= 0) return { kind: 'folder', folderDepth: day + 2 }
    const pack = packOf(root, folders[0] ?? '')
    if (pack) {
      return {
        kind: 'folder',
        folderDepth: 2,
        proposal: {
          type: pack.type,
          purpose: null,
          title: pack.title,
          pack: { type: pack.type, number: pack.number },
        },
      }
    }
    return { kind: 'folder', folderDepth: 2 }
  }
  if (isVideo && BG_ROOT.test(root)) return { kind: 'single' }
  return { kind: 'root', folderDepth: dirs <= 0 ? 0 : 1 }
}

/**
 * Why a file is not content (SPEC §6.3), by the rule of the import: a folder «не контент», the
 * references and cards of orders (`ТЗ`, `рефы`, `карточки…`), a path of the model's list
 * `legacy.not_content`. Such a file gets no draft; `null` — content.
 */
export function notContentOf(relative: readonly string[], list: readonly string[]): string | null {
  return contextOf(relative.join('/'), { isDir: false, notContent: list }).notContent ?? null
}

/** The role a file names by the export grammar (naming §5): `PPV-018_slug_teaser__0m14s.mp4`. */
export interface ExportRole {
  type: values.ContentType
  number: number
  role: values.AssetRole
  ordinal: number | null
  /** `_NN_` of a sexting: the place in the order of showing. */
  position: number | null
}

const EXPORT_START = /^(PPV|SET|SXT|CUS|FYP|LIFE|RAW|PRM)-\d{3,6}_/iu

export function exportRoleOf(fileName: string): ExportRole | null {
  if (!EXPORT_START.test(fileName)) return null
  const claims = parseLegacyName(fileName, { isDir: false })
  const number = claims.find(
    (c): c is Extract<LegacyClaim, { kind: 'number' }> =>
      c.kind === 'number' && c.payload.form === 'export',
  )
  const role = claims.find((c): c is Extract<LegacyClaim, { kind: 'role' }> => c.kind === 'role')
  if (!number || !role?.payload.role || role.payload.role === 'cap') return null
  return {
    type: number.payload.type as values.ContentType,
    number: number.payload.number,
    role: role.payload.role,
    ordinal: role.payload.ordinal,
    position: role.payload.position ?? null,
  }
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
  // `7. Монтажи` — ready clips of the editors; a photo there says nothing (`typeOfFile`).
  [MONTAGE_ROOT, 'FYP'],
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
