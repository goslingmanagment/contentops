import type { ItemTypeCode, LegacyClaim, ParsedLegacyPath, RegistryClaim } from '@contentops/legacy'
import { localDay, looseGroupOf, mediaKindOf, UPLOAD_CLUSTER_MS } from '../intake/grouping'
import type { SnapshotEntry } from './snapshot'

/**
 * The units of the old disk the byte import accepts (SPEC §6.1 grouping, §6.3): a numbered
 * folder (`[PPV-0NN]…`, `sexting_NNN…`, `[Set-NNN]…`) with everything below it is one object; a
 * folder without a number is one object with its role and tag subfolders (`ed/`, `original/`,
 * `optional/`); a FYP or a custom video is an object by itself; files right in a root are
 * grouped by the shooting day or the upload window, as intake groups them. An archive is one
 * unit until a person splits it by its folders (◆ «Разделить архив?»).
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
}

export function legacyUnits(input: UnitsInput): LegacyUnit[] {
  const { byPath, parsed } = input
  const units = new Map<string, LegacyUnit>()
  const clusters = new Map<string, { start: number; key: string }>()
  const registryOf = (name: string) =>
    input.registry.find((row) => row.payload.folder === name || nameOf(row.payload.folder) === name)

  const unit = (key: string, make: () => Omit<LegacyUnit, 'key' | 'files'>): LegacyUnit => {
    let found = units.get(key)
    if (!found) {
      found = { key, files: [], ...make() }
      units.set(key, found)
    }
    return found
  }

  const folderUnit = (folder: SnapshotEntry, anchor: SnapshotEntry, archive: boolean) => {
    const own = parsed.get(folder.relative)
    const number = numberOf(own)
    const registry =
      number?.payload.type === 'PPV' ? registryOf(nameOf(folder.relative)) : undefined
    const title = own?.claims.find((c) => c.kind === 'title')
    const tags = [
      ...registryTags(registry),
      ...(own?.claims.flatMap((c) => (c.kind === 'tag' ? [c.payload.tag] : [])) ?? []),
    ]
    const resource = anchor.resourceId ?? anchor.objectId
    return unit(
      archive ? `archive:${anchor.revisionId}:${folder.relative}` : `folder:${resource}`,
      () => ({
        grouping: 'folder',
        folder,
        path: folder.relative,
        root: rootOf(folder.relative),
        type: number?.payload.type ?? typeOf(parsed.get(anchor.relative)) ?? typeOf(own),
        ppvKind: own?.context.ppvKind ?? registry?.payload.ppv_kind ?? null,
        purpose: own?.context.rawPurpose ?? null,
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
        evidence: { legacy: { unit: folder.relative, anchor: anchor.objectId } },
      }),
    )
  }

  for (const file of input.files) {
    const parts = file.relative.split('/')
    const root = parts[0] ?? ''
    const own = parsed.get(file.relative)
    const media = mediaKindOf(nameOf(file.relative), file.mediaType ?? null)

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

    // The nearest numbered folder above the file holds it.
    let numbered: SnapshotEntry | null = null
    for (let n = parts.length - 1; n > 1; n--) {
      const dir = byPath.get(parts.slice(0, n).join('/'))
      if (dir && numberOf(parsed.get(dir.relative))) {
        numbered = dir
        break
      }
    }
    if (numbered) {
      folderUnit(numbered, numbered, false).files.push(file)
      continue
    }
    const type = typeOf(own)
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
      folderUnit(folder, folder, false).files.push(file)
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
