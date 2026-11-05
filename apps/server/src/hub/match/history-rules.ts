import { nameHandle, sameSize } from './names'

/**
 * The rules of the history pass (SPEC §7 «История страницы Fansly»), pure: what the names of a
 * platform file say about the catalog and what every match by name must pass. A candidate needs
 * a name; length and size only check it (decision 05.11.2026, after the audit of the catalog):
 *
 * - names, in this order, a later one only narrowing an earlier one that is not single: the old
 *   name of the file (on the disk, in the import); a ContentOps download name — its ID gives the
 *   object, the role and its number the file, and when that file fails a check, the one file of
 *   the object of the same length and size (packs are numbered differently, 05.11.2026); the
 *   name with what Fansly loses — `?` for every Cyrillic letter, a note in brackets («(2)»,
 *   «(louder)»), a camera number inside a longer name;
 * - checks: the same kind (photo or video); the post or the upload not before the day the file
 *   was shot (EXIF of its source, else the day of its object); a video's length within
 *   `hub_exact_duration_ms`; the same bytes in another object are the same file, and a custom
 *   with the bytes of a PPV is that PPV (SPEC §7: a custom comes out again as a PPV); of several
 *   files of one name the one of the same size;
 * - no name: a video of the same length and size, a photo of the same size — a hint, no candidate.
 */

/** A file of the catalog as the pass sees it: the current version of a live object's file. */
export interface CatalogFile {
  assetId: string
  versionId: string
  itemId: string
  /** `PPV`, `CUS`, `RAW`…: a custom with the bytes of a PPV is that PPV. */
  itemType: string
  /** SHA-256 of the master and of the source, hex: the same bytes are the same file. */
  blobs: readonly string[]
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
  /** `YYYY-MM-DD`: EXIF of the file's source, else the day of its object; `null` — unknown. */
  shotDay: string | null
}

/** A main file of a post or a file of a named vault album. */
export interface PlatformFile {
  /** The attachment's name; in the vault the card's caption and the name of the uploaded file. */
  names: readonly (string | null)[]
  isVideo: boolean
  durationMs: number | null
  width: number | null
  height: number | null
  /** The first moment the platform had the file: the post, the upload, the album. */
  seenAt: string | null
}

export type NameRule = 'download_name' | 'name' | 'lossy_name'
export type Rejection = 'kind' | 'date' | 'duration'

export type Found =
  | { kind: NameRule; assets: CatalogFile[] }
  /** A name matched, and every file of that name failed a check. */
  | { kind: 'rejected'; reason: Rejection }
  /** No name: a video of the same length and size. */
  | { kind: 'shape_hint' }
  /** No name: a photo of the same size. */
  | { kind: 'photo_hint' }
  | null

export interface Catalog {
  files: readonly CatalogFile[]
  /** Stems of the old names: legacy names and paths, names on the disk. */
  byStem: ReadonlyMap<string, readonly CatalogFile[]>
  /** `SXT-3|pic67`: the files of the objects by role and number, also the handles of moved files. */
  byHandle: ReadonlyMap<string, readonly CatalogFile[]>
  /** `SXT-3`: the files an ID of a download name may mean. */
  byItem: ReadonlyMap<string, readonly CatalogFile[]>
  /** The files of the same bytes. */
  byBlob: ReadonlyMap<string, readonly CatalogFile[]>
  /** Stems with letters Fansly turns into `?`, NFC and NFD, by length in code points. */
  lossy: ReadonlyMap<number, readonly { form: string; stem: string }[]>
}

/** The name without folder and extension, NFC, lower case: `IMG_5002.MOV` → `img_5002`. */
export function stemOf(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .normalize('NFC')
    .replace(/^.*\//, '')
    .replace(/\.[^./]*$/, '')
    .trim()
    .toLowerCase()
}

const NON_ASCII = /[\u0080-\u{10ffff}]/u

export function buildCatalog(
  files: readonly CatalogFile[],
  names: readonly { assetId: string; name: string }[],
  handles: readonly { key: string; assetId: string }[],
): Catalog {
  const byAsset = new Map(files.map((file) => [file.assetId, file]))
  const index = (pairs: Iterable<[string, string]>) => {
    const out = new Map<string, CatalogFile[]>()
    for (const [key, assetId] of pairs) {
      const file = byAsset.get(assetId)
      if (!key || !file) continue
      const list = out.get(key) ?? []
      if (!list.includes(file)) list.push(file)
      out.set(key, list)
    }
    return out
  }
  const byStem = index(names.map((entry) => [stemOf(entry.name), entry.assetId]))
  const byHandle = index(handles.map((entry) => [entry.key, entry.assetId]))
  const byItem = index(handles.map((entry) => [entry.key.split('|')[0] as string, entry.assetId]))
  const byBlob = index(
    files.flatMap((file) => file.blobs.map((blob): [string, string] => [blob, file.assetId])),
  )
  const lossy = new Map<number, { form: string; stem: string }[]>()
  for (const stem of byStem.keys()) {
    if (!NON_ASCII.test(stem)) continue
    // A name typed on a Mac keeps «й» as two code points: Fansly may give two `?` for it.
    for (const form of new Set([stem, stem.normalize('NFD')])) {
      const length = [...form].length
      const list = lossy.get(length) ?? []
      list.push({ form, stem })
      lossy.set(length, list)
    }
  }
  return { files, byStem, byHandle, byItem, byBlob, lossy }
}

/**
 * A note in brackets at the end: « (2)» a computer adds to a copy, « (louder)» of a montage with
 * the sound evened out — `img_8211 (2)` → `img_8211`.
 */
export function withoutNote(stem: string): string | null {
  const bare = stem.replace(/\s+\([^()]{1,24}\)$/, '')
  return bare !== stem && bare !== '' ? bare : null
}

const CAMERA = /(?<![a-z0-9])(?:img|dsc[fn]?|mvi|vid|pxl)[_-]?e?\d{4,}/g
const UUID =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/g

/** Camera numbers inside a longer name: `081__сцена__img_5002`, `img_5003face` → `img_5002`… */
export function cameraNumbers(stem: string): string[] {
  const found = [...stem.matchAll(CAMERA), ...stem.matchAll(UUID)].map((match) => match[0])
  return [...new Set(found)].filter((token) => token !== stem)
}

const MIN_KEPT = 4

/**
 * A name with `?` for every letter Fansly lost (V1: Cyrillic becomes `?`, one per letter) as a
 * pattern over the catalog's names. Safe only with something left: at least four other
 * characters, one of them a Latin letter or a digit; `???????????.jpeg` says nothing.
 */
export function lossyPattern(stem: string): RegExp | null {
  if (!stem.includes('?')) return null
  const kept = [...stem].filter((char) => char !== '?')
  if (kept.length < MIN_KEPT || !kept.some((char) => /[a-z0-9]/.test(char))) return null
  const body = [...stem]
    .map((char) =>
      char === '?' ? '[\\u0080-\\u{10ffff}]' : char.replace(/[.*+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('')
  return new RegExp(`^${body}$`, 'u')
}

function lossyMatches(stem: string, catalog: Catalog): CatalogFile[] {
  const stems = new Set<string>()
  const bare = withoutNote(stem)
  if (bare) stems.add(bare)
  for (const token of cameraNumbers(bare ?? stem)) stems.add(token)
  const pattern = lossyPattern(stem)
  if (pattern) {
    for (const entry of catalog.lossy.get([...stem].length) ?? []) {
      if (pattern.test(entry.form)) stems.add(entry.stem)
    }
  }
  return [...stems].flatMap((one) => catalog.byStem.get(one) ?? [])
}

/** The local day of an instant: `YYYY-MM-DD` in the model's time zone. */
export function localDay(at: string, timezone: string): string {
  return new Date(at).toLocaleDateString('sv-SE', { timeZone: timezone })
}

export interface CheckOptions {
  /** `hub_exact_duration_ms`; no value — lengths are not checked (SPEC §7 «Настройки»). */
  durationMs: number | null
  timezone: string
}

/** Why a file of the catalog cannot be this platform file; `null` — it can. */
export function rejection(
  file: PlatformFile,
  ours: CatalogFile,
  options: CheckOptions,
): Rejection | null {
  if (file.isVideo !== ours.isVideo) return 'kind'
  if (ours.shotDay && file.seenAt && localDay(file.seenAt, options.timezone) < ours.shotDay) {
    return 'date'
  }
  if (
    file.isVideo &&
    options.durationMs !== null &&
    file.durationMs !== null &&
    ours.durationMs !== null &&
    Math.abs(file.durationMs - ours.durationMs) > options.durationMs
  ) {
    return 'duration'
  }
  return null
}

/** Of several files of one name, those of the same size, if that narrows them. */
function bySize(file: PlatformFile, files: CatalogFile[]): CatalogFile[] {
  if (files.length < 2) return files
  const sized = files.filter((ours) => sameSize(ours, file) === true)
  return sized.length > 0 ? sized : files
}

/** The same length (a video) and size: what picks a file inside an object a name gives. */
function sameShape(file: PlatformFile, ours: CatalogFile, durationMs: number | null): boolean {
  if (sameSize(ours, file) !== true) return false
  if (!file.isVideo) return true
  return (
    durationMs !== null &&
    file.durationMs !== null &&
    ours.durationMs !== null &&
    Math.abs(file.durationMs - ours.durationMs) <= durationMs
  )
}

/**
 * The files a download name points at: the file of its role and number; when that one fails a
 * check, the one file of the object of the same length and size (a pack numbered otherwise).
 */
function byDownloadName(
  file: PlatformFile,
  names: readonly string[],
  catalog: Catalog,
  options: CheckOptions,
): CatalogFile[] {
  const out: CatalogFile[] = []
  for (const name of names) {
    const key = nameHandle(name)
    if (!key) continue
    const named = (catalog.byHandle.get(key) ?? []).filter(
      (ours) => rejection(file, ours, options) === null,
    )
    if (named.length > 0) {
      out.push(...named)
      continue
    }
    const shaped = (catalog.byItem.get(key.split('|')[0] as string) ?? []).filter(
      (ours) =>
        rejection(file, ours, options) === null && sameShape(file, ours, options.durationMs),
    )
    if (shaped.length === 1) out.push(...shaped)
    else out.push(...(catalog.byHandle.get(key) ?? []))
  }
  return out
}

/**
 * The same bytes in other objects are the same file; a custom whose bytes are a PPV's is that
 * PPV (SPEC §7: «повторно выходит как PPV из кастома»).
 */
function sameBytes(files: readonly CatalogFile[], catalog: Catalog): CatalogFile[] {
  const all = new Set(files)
  const items = new Set(files.map((file) => file.itemId))
  for (const file of files) {
    for (const blob of file.blobs) {
      // A copy inside the same object is not a second answer.
      for (const twin of catalog.byBlob.get(blob) ?? []) if (!items.has(twin.itemId)) all.add(twin)
    }
  }
  return [...all].filter(
    (ours) =>
      ours.itemType !== 'CUS' ||
      !ours.blobs.some((blob) =>
        (catalog.byBlob.get(blob) ?? []).some((twin) => all.has(twin) && twin.itemType !== 'CUS'),
      ),
  )
}

/** What the catalog says about one platform file: by name, else at most a hint. */
export function findFile(file: PlatformFile, catalog: Catalog, options: CheckOptions): Found {
  const names = [...new Set(file.names.filter((name): name is string => Boolean(name)))]
  const stems = [...new Set(names.map(stemOf).filter((stem) => stem !== ''))]
  const tiers: [NameRule, () => CatalogFile[]][] = [
    ['name', () => stems.flatMap((stem) => catalog.byStem.get(stem) ?? [])],
    ['download_name', () => byDownloadName(file, names, catalog, options)],
    ['lossy_name', () => stems.flatMap((stem) => lossyMatches(stem, catalog))],
  ]
  let found: { rule: NameRule; assets: CatalogFile[] } | null = null
  let rejected: Rejection | null = null
  for (const [rule, read] of tiers) {
    if (found && found.assets.length === 1) break
    const passed: CatalogFile[] = []
    for (const ours of new Set(read())) {
      const why = rejection(file, ours, options)
      if (why === null) passed.push(ours)
      else rejected = rejected ?? why
    }
    if (passed.length === 0) continue
    // A later reading of the name narrows an earlier one; it never overrules it.
    const narrowed: CatalogFile[] = found
      ? found.assets.filter((ours) => passed.includes(ours))
      : passed
    if (!found) found = { rule, assets: passed }
    else if (narrowed.length > 0) found = { rule: found.rule, assets: narrowed }
  }
  if (found) {
    const same = sameBytes(found.assets, catalog).filter(
      (ours) => rejection(file, ours, options) === null,
    )
    return { kind: found.rule, assets: bySize(file, same) }
  }
  if (rejected !== null) return { kind: 'rejected', reason: rejected }
  // Length and size alone are a hint, not a candidate (SPEC §7).
  if (file.isVideo) {
    const tolerance = options.durationMs
    if (tolerance === null || file.durationMs === null) return null
    const fits = catalog.files.some((ours) => ours.isVideo && sameShape(file, ours, tolerance))
    return fits ? { kind: 'shape_hint' } : null
  }
  return catalog.files.some((ours) => !ours.isVideo && sameSize(ours, file) === true)
    ? { kind: 'photo_hint' }
    : null
}

export type Matched = Extract<Found, { assets: CatalogFile[] }>

export function isMatched(found: Found): found is Matched {
  return found !== null && 'assets' in found
}

/** One object for every matched file: the post is that object's candidate; else disputed. */
export function verdictOf(
  found: readonly Found[],
): { itemId: string; assets: CatalogFile[] } | 'disputed' | null {
  const matched = found.filter(isMatched)
  if (matched.length === 0) return null
  const items = new Set(matched.flatMap((entry) => entry.assets.map((asset) => asset.itemId)))
  if (items.size !== 1) return 'disputed'
  const assets = new Map<string, CatalogFile>()
  for (const entry of matched) {
    // One file — one file of the catalog; two files of one object for one file stay a dispute.
    if (new Set(entry.assets.map((asset) => asset.assetId)).size !== 1) return 'disputed'
    const [asset] = entry.assets
    if (asset) assets.set(asset.assetId, asset)
  }
  return { itemId: [...items][0] as string, assets: [...assets.values()] }
}
