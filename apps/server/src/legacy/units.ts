import type {
  ItemTypeCode,
  LegacyClaim,
  PackPlan,
  ParsedLegacyPath,
  RegistryClaim,
} from '@contentops/legacy'
import { localDay, looseGroupOf, mediaKindOf, UPLOAD_CLUSTER_MS } from '../intake/grouping'
import type { SnapshotEntry } from './snapshot'

/**
 * The units of the old disk the byte import accepts (SPEC §6.1 grouping, §6.3): a numbered
 * folder (`[PPV-0NN]…`, `sexting_NNN…`, `[Set-NNN]…`, a pack `PPV-001 Белое бельё`) with
 * everything below it is one object; a folder without a number is one object with its role and
 * tag subfolders (`ed/`, `original/`, `Дубли/`); a FYP or a custom video is an object by itself,
 * except in a folder of customs that answers one card (`05.10.26 <покупатель> <что>`, `4 Видео`):
 * that folder is one custom, its longest clip the master and the others its parts; files right
 * in a root are grouped by the shooting day or the upload window, as intake groups them. An archive is one unit until a person splits it by its folders
 * (◆ «Разделить архив?»).
 *
 * A pack holds its object (`PackPlan` of the dry run): an old folder of its number sharing its
 * bytes and the copies of its files elsewhere join its group, where equal bytes are one file and
 * the rest aliases (SPEC §6.2). Copies for the platform inside a pack (`сжатое для волта`) are a
 * group of their own without a type: a person decides. Not content makes no unit.
 */

export interface LegacyUnit {
  /** `inbox_groups.group_key`, built from ids at the source like intake's. */
  key: string
  grouping: 'folder' | 'exif_day' | 'upload_cluster' | 'single'
  /** The folder of the unit (or the archive), when it has one. */
  folder: SnapshotEntry | null
  /** Path of the unit: the folder, the archive or the single file. */
  path: string
  /** Top folder of the old disk (`1. PPV`). */
  root: string
  type: ItemTypeCode | null
  ppvKind: 'bundle' | 'dm' | null
  purpose: 'fyp' | 'ppv' | 'mass_dm' | null
  title: string | null
  titleEn: string | null
  tags: string[]
  /** The number the name claims: `[PPV-032]` → PPV 32; its claim key finds the decision. */
  number: { type: ItemTypeCode; number: number; claimKey: string; anchor: string } | null
  files: SnapshotEntry[]
  /** Archive unit: folders right under the archive's top (several → ◆ split). */
  archiveFolders: string[]
  evidence: Record<string, unknown>
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const rootOf = (path: string) => path.split('/')[0] ?? ''

/** A role or tag subfolder (`ed/`, `original/`, `optional/`): part of the object above it. */
function structural(parsed: ParsedLegacyPath | undefined): boolean {
  if (!parsed) return false
  const own = parsed.claims.filter((c) => c.kind !== 'unknown')
  return own.length > 0 && own.every((c) => c.kind === 'role' || c.kind === 'tag')
}

function numberOf(parsed: ParsedLegacyPath | undefined) {
  const claim = parsed?.claims.find(
    (c): c is Extract<LegacyClaim, { kind: 'number' }> =>
      c.kind === 'number' && c.payload.reserves && c.payload.form !== 'registry',
  )
  return claim ?? null
}

function typeOf(parsed: ParsedLegacyPath | undefined): ItemTypeCode | null {
  const hint = parsed?.context.typeHint ?? null
  return hint === 'LIFE|SET' ? null : hint
}

/** Words of the registry tag groups, lower case and without repeats. */
function registryTags(row: RegistryClaim | undefined): string[] {
  if (!row) return []
  const { actions, attributes, mood } = row.payload.tags
  return [...new Set([...actions, ...attributes, ...mood].map((t) => t.trim()).filter(Boolean))]
}

export interface UnitsInput {
  /** Files of the snapshot in scope, archive members included. */
  files: readonly SnapshotEntry[]
  /** Every listed entry of the snapshot by root-relative path (folders and archives too). */
  byPath: ReadonlyMap<string, SnapshotEntry>
  parsed: ReadonlyMap<string, ParsedLegacyPath>
  registry: readonly RegistryClaim[]
  timezone: string
  /** Packs of the dry run: their old folders and the copies of their files. */
  packs?: readonly PackPlan[]
}

/** Copies for the platform a pack keeps beside its originals: not new material. */
const PLATFORM_COPIES = /сжат|compress|(?<![\p{L}])crf\s?\d|normaliz|для\s+(волта|vault)/iu
/**
 * Folders of customs that hold many orders: a bare day (`17.10.26`), the nightly drop of a mirror,
 * and a choice for PPV (`отобранное на PPV`) — a custom per clip there.
 */
const MANY_ORDERS = /^(?:\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4})|.*отобранное\s+на\s+ppv.*)$/iu
/** `10.04.26 ванная топлес`: the date first, then what was shot — the day of the shoot. */
const SHOOT_FOLDER = /^\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4})\s+\S/u

/** The day a shoot folder names (`YYYY-MM-DD`): the object's day when its files carry none. */
function shootDay(folder: ParsedLegacyPath | undefined): string | null {
  if (!folder?.isDir || !SHOOT_FOLDER.test(folder.name)) return null
  const date = folder.claims.find((c) => c.kind === 'date')
  const iso = date?.kind === 'date' ? (date.payload.date?.iso ?? null) : null
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null
}

export function legacyUnits(input: UnitsInput): LegacyUnit[] {
  const { byPath, parsed } = input
  const units = new Map<string, LegacyUnit>()
  const clusters = new Map<string, { start: number; key: string }>()
  const registryOf = (name: string) =>
    input.registry.find((row) => row.payload.folder === name || nameOf(row.payload.folder) === name)
  // A pack and what is the same object as it is: old folders of its number, copies of its files.
  const packOfFolder = new Map<string, PackPlan>()
  const packOfCopy = new Map<string, PackPlan>()
  for (const pack of input.packs ?? []) {
    for (const folder of pack.folders) packOfFolder.set(folder, pack)
    for (const copy of pack.copies) packOfCopy.set(copy, pack)
  }
  const objectsOf = (paths: readonly string[]) =>
    paths.flatMap((path) => {
      const entry = byPath.get(path)
      return entry ? [entry.objectId] : []
    })
  // A folder right in the section of customs that answers one card (SPEC §6.1): named by its
  // order (`05.10.26 <покупатель> <что>`) or by what was shot (`4 Видео`, `10:08 черное платье`).
  // The section is `3. Customs`, or `Customs` inside `BG` and «Старый формат».
  const replyFolder = (path: string) => {
    const own = parsed.get(path)
    if (!own || typeOf(own) !== 'CUS') return false
    const depth = own.context.area === own.context.subArea ? 2 : 3
    return (
      path.split('/').length === depth && !MANY_ORDERS.test(nameOf(path).normalize('NFC').trim())
    )
  }

  const unit = (key: string, make: () => Omit<LegacyUnit, 'key' | 'files'>): LegacyUnit => {
    let found = units.get(key)
    if (!found) {
      found = { key, files: [], ...make() }
      units.set(key, found)
    }
    return found
  }

  const folderUnit = (
    folder: SnapshotEntry,
    anchor: SnapshotEntry,
    archive: boolean,
    untyped = false,
    file?: ParsedLegacyPath,
  ) => {
    const own = parsed.get(folder.relative)
    const number = untyped ? null : numberOf(own)
    // Takes of a FYP (`…/Дубли/…`) make their folder raw material for FYPs (SPEC §6.1).
    const takes = file?.context.typeHint === 'RAW' && file.context.rawPurpose === 'fyp'
    const registry =
      number?.payload.type === 'PPV' ? registryOf(nameOf(folder.relative)) : undefined
    const title = own?.claims.find((c) => c.kind === 'title')
    const tags = [
      ...registryTags(registry),
      ...(own?.claims.flatMap((c) => (c.kind === 'tag' ? [c.payload.tag] : [])) ?? []),
    ]
    const resource = anchor.resourceId ?? anchor.objectId
    const pack =
      number?.payload.form === 'pack'
        ? input.packs?.find((p) => p.path === folder.relative)
        : undefined
    return unit(
      archive ? `archive:${anchor.revisionId}:${folder.relative}` : `folder:${resource}`,
      () => ({
        grouping: 'folder',
        folder,
        path: folder.relative,
        root: rootOf(folder.relative),
        type: untyped
          ? null
          : takes && !number
            ? 'RAW'
            : (number?.payload.type ?? typeOf(parsed.get(anchor.relative)) ?? typeOf(own)),
        ppvKind: own?.context.ppvKind ?? registry?.payload.ppv_kind ?? null,
        purpose: takes && !number ? 'fyp' : (own?.context.rawPurpose ?? null),
        title: title?.kind === 'title' ? title.payload.text : null,
        titleEn: registry?.payload.title_en ?? null,
        tags: [...new Set(tags)],
        number: number
          ? {
              type: number.payload.type,
              number: number.payload.number,
              claimKey: number.claim_key,
              anchor: anchor.objectId,
            }
          : null,
        archiveFolders: [],
        evidence: {
          legacy: {
            unit: folder.relative,
            anchor: anchor.objectId,
            // Old folders of the pack's number: their claims settle with the object.
            ...(pack && pack.folders.length > 0 ? { folders: objectsOf(pack.folders) } : {}),
            // The custom of a folder of the answer (or of a numbered one, `[CUS-001]_…`) answers
            // to the names of its files too: what the model's reply to the card named.
            ...(replyFolder(folder.relative) || number?.payload.type === 'CUS'
              ? { order_folder: folder.relative }
              : {}),
          },
          ...(untyped ? { platform_copies: true } : {}),
          ...(!archive && shootDay(own) ? { shot_day: shootDay(own) } : {}),
        },
      }),
    )
  }

  for (const file of input.files) {
    const parts = file.relative.split('/')
    const root = parts[0] ?? ''
    const own = parsed.get(file.relative)
    const media = mediaKindOf(nameOf(file.relative), file.mediaType ?? null)
    // Not content (SPEC §6.3): no unit, no draft; the reconciliation counts it apart.
    if (own?.context.notContent) continue

    // A member of an archive: the archive is the unit until a person splits it by its parts —
    // the numbered folders inside, else its top folders.
    if (file.archiveEntry) {
      const archive = byPath.get(file.archiveEntry.archivePath)
      if (!archive) continue
      const part = archivePart(file, parsed)
      const u = unit(`archive:${archive.revisionId}`, () => {
        const parsedArchive = parsed.get(archive.relative)
        return {
          grouping: 'folder',
          folder: archive,
          path: archive.relative,
          root: rootOf(archive.relative),
          type: typeOf(parsedArchive),
          ppvKind: parsedArchive?.context.ppvKind ?? null,
          purpose: parsedArchive?.context.rawPurpose ?? null,
          title: null,
          titleEn: null,
          tags: [],
          number: null,
          archiveFolders: [],
          evidence: {
            legacy: { unit: archive.relative, anchor: archive.objectId, archive: true },
            parts: {},
            numbers: {},
          },
        }
      })
      if (!u.archiveFolders.includes(part.path)) u.archiveFolders.push(part.path)
      const evidence = u.evidence as {
        parts: Record<string, string>
        numbers: Record<string, unknown>
      }
      evidence.parts[file.revisionId as string] = part.path
      if (part.number) {
        const number = {
          type: part.number.payload.type,
          number: part.number.payload.number,
          claimKey: part.number.claim_key,
          anchor: archive.objectId,
        }
        evidence.numbers[part.path] = number
        if (part.number.payload.type) u.type = u.type ?? part.number.payload.type
      }
      u.files.push(file)
      continue
    }

    // A copy of a pack's file elsewhere (`1. PPV/19.10.26/…`, `7. Монтажи/Агент/PPV-016/…`):
    // the same file again, in the pack's group.
    const copyOf = packOfCopy.get(file.relative)
    const copyHolder = copyOf ? byPath.get(copyOf.path) : undefined
    if (copyHolder) {
      folderUnit(copyHolder, copyHolder, false).files.push(file)
      continue
    }

    // A folder of a channel or contractor in SMM is a collection of «Промо» (SPEC §6.3): the
    // folder right above the files, as the dry run lists them for marking.
    if (own?.context.area === 'smm' && parts.length > 2) {
      const folder = byPath.get(parentOf(file.relative))
      if (folder) {
        unit(`folder:${folder.resourceId ?? folder.objectId}`, () => ({
          grouping: 'folder',
          folder,
          path: folder.relative,
          root,
          type: 'PRM',
          ppvKind: null,
          purpose: null,
          title: nameOf(folder.relative),
          titleEn: null,
          tags: [],
          number: null,
          archiveFolders: [],
          evidence: {
            legacy: { unit: folder.relative, anchor: folder.objectId },
            promo: { channel: own.context.promoChannel, folder: folder.relative },
          },
        })).files.push(file)
        continue
      }
    }

    // The nearest numbered folder above the file holds it; an old folder of a pack's number
    // sharing its bytes is the pack's.
    let numbered: SnapshotEntry | null = null
    let below: string | null = null
    for (let n = parts.length - 1; n > 1; n--) {
      const dir = byPath.get(parts.slice(0, n).join('/'))
      if (dir && numberOf(parsed.get(dir.relative))) {
        numbered = dir
        below = n + 1 < parts.length ? parts.slice(0, n + 1).join('/') : null
        break
      }
    }
    if (numbered) {
      const pack = packOfFolder.get(numbered.relative)
      const holder = (pack ? byPath.get(pack.path) : undefined) ?? numbered
      // Copies for the platform beside a pack's originals: their own group, a person decides.
      const sub = below ? byPath.get(below) : undefined
      if (
        sub?.isDir &&
        numberOf(parsed.get(holder.relative))?.payload.form === 'pack' &&
        PLATFORM_COPIES.test(nameOf(sub.relative))
      ) {
        folderUnit(sub, sub, false, true).files.push(file)
        continue
      }
      folderUnit(holder, holder, false).files.push(file)
      continue
    }
    const type = typeOf(own)
    // The folder of the answer to one card is one custom: its clips, the parts of one video, and
    // its photos (SPEC §6.1) — whatever depth below it they lie at.
    const answer =
      type === 'CUS'
        ? [2, 3]
            .map((depth) => parts.slice(0, depth).join('/'))
            .find((path, i) => parts.length > i + 2 && replyFolder(path))
        : undefined
    if (answer) {
      const folder = byPath.get(answer)
      if (folder) {
        folderUnit(folder, folder, false).files.push(file)
        continue
      }
    }
    // A FYP montage or a custom video is an object by itself.
    if (media === 'video' && (type === 'FYP' || type === 'CUS')) {
      unit(`single:${file.resourceId ?? file.objectId}`, () => ({
        grouping: 'single',
        folder: null,
        path: file.relative,
        root,
        type,
        ppvKind: null,
        purpose: own?.context.rawPurpose ?? null,
        title: own?.claims.find((c) => c.kind === 'title')?.raw_fragment ?? null,
        titleEn: null,
        tags: [],
        number: null,
        archiveFolders: [],
        evidence: { legacy: { unit: file.relative, anchor: file.objectId } },
      })).files.push(file)
      continue
    }
    // A folder without a number: up past its role and tag subfolders.
    let depth = parts.length - 1
    while (depth > 2 && structural(parsed.get(parts.slice(0, depth).join('/')))) depth -= 1
    const folder = depth >= 2 ? byPath.get(parts.slice(0, depth).join('/')) : undefined
    if (folder) {
      folderUnit(folder, folder, false, false, own).files.push(file)
      continue
    }
    // Right in a root: by the shooting day or the upload window (SPEC §6.1).
    const rootDir = byPath.get(root)
    const folderId = rootDir?.resourceId ?? 'root'
    const loose = looseGroupOf(
      {
        fileId: file.resourceId ?? file.objectId,
        isVideo: media === 'video',
        shotAt: file.shotAt ?? null,
        rootName: parts.length > 1 ? root : null,
      },
      folderId,
      input.timezone,
    )
    let key: string
    let grouping: LegacyUnit['grouping']
    if (loose.grouping === 'upload_cluster') {
      const at = Date.parse(file.createdAt ?? file.modifiedAt ?? '') || 0
      const open = clusters.get(loose.prefix)
      if (!open || at < open.start || at >= open.start + UPLOAD_CLUSTER_MS) {
        clusters.set(loose.prefix, {
          start: at,
          key: `${loose.prefix}${new Date(at).toISOString()}`,
        })
      }
      key = clusters.get(loose.prefix)?.key as string
      grouping = 'upload_cluster'
    } else {
      key = loose.key
      grouping = loose.grouping
    }
    unit(key, () => ({
      grouping,
      folder: rootDir ?? null,
      path: parts.length > 1 ? root : file.relative,
      root,
      type,
      ppvKind: own?.context.ppvKind ?? null,
      purpose: own?.context.rawPurpose ?? null,
      title: null,
      titleEn: null,
      tags: [],
      number: null,
      archiveFolders: [],
      evidence: {
        legacy: { unit: root, anchor: file.objectId },
        ...(loose.grouping === 'exif_day' ? { day: loose.day } : {}),
        ...(file.createdAt ? { first_upload: localDay(file.createdAt, input.timezone) } : {}),
      },
    })).files.push(file)
  }
  const out = [...units.values()]
  settleArchiveUnits(out)
  return out
}

/**
 * The part of an archive a member belongs to: the nearest numbered folder inside the archive,
 * else its top folder, else the archive's own top (`''`).
 */
export function archivePart(
  member: SnapshotEntry,
  parsed: ReadonlyMap<string, ParsedLegacyPath>,
): { path: string; number: Extract<LegacyClaim, { kind: 'number' }> | null } {
  const archivePath = member.archiveEntry?.archivePath ?? ''
  const inner = member.relative.slice(archivePath.length + 1).split('/')
  for (let n = inner.length - 1; n >= 1; n--) {
    const path = `${archivePath}/${inner.slice(0, n).join('/')}`
    const number = numberOf(parsed.get(path))
    if (number) return { path, number }
  }
  return { path: inner.length > 1 ? `${archivePath}/${inner[0]}` : '', number: null }
}

/** With one part, the archive's unit takes that part's number. */
export function settleArchiveUnits(units: readonly LegacyUnit[]): void {
  for (const u of units) {
    const evidence = u.evidence as { numbers?: Record<string, LegacyUnit['number']> }
    if (!evidence.numbers || u.archiveFolders.length !== 1) continue
    u.number = evidence.numbers[u.archiveFolders[0] as string] ?? null
  }
}

export { parentOf }
