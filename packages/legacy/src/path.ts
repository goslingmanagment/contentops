import { type NameContext, parseLegacyName } from './name.ts'
import { ARCHIVE_EXTENSIONS, nfc, relativePath, splitExtension } from './text.ts'
import type {
  ItemTypeCode,
  LegacyArea,
  ParsedLegacyPath,
  ParseOptions,
  PathContext,
} from './types.ts'

/** `1. PPV`, `PPV`, `Sets`, `5. Sextings` → the area; `BG`, «Старый формат» are their own. */
export function areaOfSection(name: string): LegacyArea | null {
  const word = /^(?:\d+\.\s*)?(.+?)\s*$/u.exec(nfc(name))?.[1]?.toLowerCase() ?? ''
  switch (word) {
    case 'ppv':
      return 'ppv'
    case 'fyp':
      return 'fyp'
    case 'customs':
    case 'custom':
      return 'customs'
    case 'sets':
    case 'set':
      return 'sets'
    case 'sextings':
    case 'sexting':
      return 'sextings'
    case 'life':
      return 'life'
    case 'pictures':
      return 'pictures'
    case 'other':
      return 'other'
    case 'smm':
      return 'smm'
    case 'bg':
      return 'bg'
    case 'старый формат':
      return 'old_format'
    default:
      return null
  }
}

const CHANNEL = /^(twitter|instagram|reddit|sfs|yt|gif сайты|tiktok|флешинги)$/iu

function isArchiveName(name: string): boolean {
  const { ext } = splitExtension(name, false)
  return ext !== null && ARCHIVE_EXTENSIONS.has(ext)
}

const TYPE_OF_AREA: Partial<Record<LegacyArea, ItemTypeCode | 'LIFE|SET'>> = {
  ppv: 'PPV',
  fyp: 'FYP',
  customs: 'CUS',
  sets: 'SET',
  sextings: 'SXT',
  life: 'LIFE',
  pictures: 'LIFE|SET',
  other: 'RAW',
}

/**
 * Section, sub-section and the hints the path gives (legacy §2, §8, §9.2). Hints only: the
 * type of a future object is decided at intake.
 */
export function contextOf(path: string, options: ParseOptions): PathContext {
  const segments = relativePath(path).split('/').filter(Boolean)
  const name = segments[segments.length - 1] ?? ''
  let archiveAt = -1
  for (let i = 0; i < segments.length - 1; i++) {
    if (isArchiveName(segments[i] ?? '')) archiveAt = i
  }
  const archive = archiveAt >= 0 ? segments.slice(0, archiveAt + 1).join('/') : null
  const inner = segments.slice(archiveAt + 1)
  const isArchive = !options.isDir && isArchiveName(name)
  const first = inner[0] ?? ''
  let area: LegacyArea
  if (inner.length === 0) area = 'root'
  else if (inner.length === 1 && !options.isDir) area = 'root'
  else area = areaOfSection(first) ?? 'unknown'
  let subArea = area
  if ((area === 'bg' || area === 'old_format') && inner.length > 1) {
    const second = inner[1] ?? ''
    const nested = areaOfSection(second)
    if (nested && (inner.length > 2 || options.isDir)) subArea = nested
  }
  const genre =
    area === 'bg' || (area === 'old_format' && areaOfSection(inner[1] ?? '') === 'bg') ? 'bg' : null
  const lower = inner.map((s) => s.toLowerCase())
  const channelAt = lower.findIndex((s, i) => i > 0 && CHANNEL.test(s))
  const promoChannel =
    (area === 'smm' || area === 'bg') &&
    channelAt > 0 &&
    channelAt < inner.length - (options.isDir ? 0 : 1)
      ? (inner[channelAt] ?? null)
      : null
  const vendor = lower.some((s) => s === 'steadycontent') ? 'steadycontent' : null
  const foreignModel =
    area === 'root' && isArchive
      ? ((options.foreignModelNames ?? []).find((model) =>
          new RegExp(`(?<![\\p{L}])${model}(?![\\p{L}])`, 'iu').test(name),
        ) ?? null)
      : null

  let typeHint: PathContext['typeHint'] = TYPE_OF_AREA[subArea] ?? null
  let rawPurpose: PathContext['rawPurpose'] = null
  let ppvKind: PathContext['ppvKind'] = null
  const selectedForPpv = lower.includes('отобранное на ppv')
  if (subArea === 'ppv') {
    if (lower.includes('bundles') || /bundles/i.test(name)) ppvKind = 'bundle'
    else if (inner.some((s) => /^\[PPV-\d+\]/i.test(s))) ppvKind = 'dm'
    if (inner.slice(1).some((s) => /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s))) {
      typeHint = 'RAW'
      rawPurpose = 'ppv'
      ppvKind = null
    }
  }
  if (subArea === 'other' && lower.includes('под рассылки')) rawPurpose = 'mass_dm'
  if (subArea === 'smm') {
    if (promoChannel) typeHint = 'PRM'
    else {
      typeHint = 'RAW'
      rawPurpose = 'fyp'
    }
  }
  if (area === 'bg' && subArea === 'bg') {
    if (promoChannel) typeHint = 'PRM'
    else if (!options.isDir && inner.length === 2 && /^\d{1,2}:\d{2}\s/.test(name)) typeHint = 'CUS'
    else typeHint = 'RAW'
  }
  if (area === 'root' || area === 'unknown') typeHint = isArchive || options.isDir ? null : 'RAW'
  if (area === 'old_format' && subArea === 'old_format') typeHint = null

  return {
    root: segments.length > 1 || options.isDir ? (segments[0] ?? '') : '',
    area,
    subArea,
    genre,
    typeHint,
    rawPurpose,
    ppvKind,
    promoChannel,
    vendor,
    archive,
    isArchive,
    foreignModel,
    selectedForPpv,
  }
}

/**
 * One path of the old disk → its section and the claims of its own name. Ancestors are parsed
 * as their own entries: a folder's claims belong to the folder.
 */
export function parseLegacyPath(path: string, options: ParseOptions): ParsedLegacyPath {
  const rel = relativePath(path)
  const segments = rel.split('/').filter(Boolean)
  const name = segments[segments.length - 1] ?? ''
  const context = contextOf(rel, options)
  const nameContext: NameContext = {
    isDir: options.isDir,
    area: context.area,
    subArea: context.subArea,
  }
  return {
    path: rel,
    name,
    isDir: options.isDir,
    context,
    claims: name === '' ? [] : parseLegacyName(name, nameContext),
  }
}
