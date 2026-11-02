import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { MediaPreview } from '@contentops/contracts/domain/common'
import type { FileVersion, MasterFrame } from '@contentops/contracts/domain/files'
import {
  FILE_ROLE_LABEL,
  type FileRole,
  type FypVersion,
  type ItemFile,
} from '@contentops/contracts/domain/files'
import type { ItemDetail, ItemLifecycle, OldName } from '@contentops/contracts/domain/item'
import type { UniqLevel } from '@contentops/contracts/domain/model'
import type { ProvenanceLink, ProvenanceRelation } from '@contentops/contracts/domain/provenance'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instant } from '../commands'
import type { ModelScope } from '../context'
import { mediaPreviews } from '../media/previews'
import { itemOrderSummary } from '../orders/view'
import { loadState } from '../plan/state'
import { itemPages, versionPlacements } from '../plan/summaries'
import { handoffsOf, itemPromo } from '../promo/views'
import { catalogEntries, rawPurposeOf, renditionUrl, thumbRatio } from './entries'
import {
  type DbItemType,
  findItem,
  type ItemRow,
  itemsByIds,
  itemTypeOfDb,
  publicIdOf,
  publicIdOfRow,
} from './ids'
import { markupFields, principalNames } from './markup'

/**
 * The object page (DESIGN §4.4) from the catalog tables. Placements, plan rows, orders,
 * handoffs and receipts come with their stages: until then «где залито» says «не видели» on
 * every page and the lists are empty (DESIGN §3.10).
 */

export interface MembershipRow extends Record<string, unknown> {
  id: string
  item_id: string
  asset_id: string
  kind: 'owned' | 'reference'
  role: 'master' | 'teaser' | 'pic' | 'raw' | 'ed' | 'clip' | 'thumb' | 'cap'
  ordinal: number | null
  variant_no: number
  display_position: number | null
  selected: boolean
  life_use: 'feed' | 'chats' | 'both' | null
  row_version: number
  media_kind: 'video' | 'image'
  uniq_level: UniqLevel | null
  version_id: string
  version_no: number
  duration_ms: number | null
  width: number | null
  height: number | null
  byte_size: number
  ext: string
  created_at: string
  /** Owner of a referenced file (a `PRM` collection points at another object's file). */
  owner_item_id: string | null
  owner_role: MembershipRow['role'] | null
  owner_ordinal: number | null
  owner_variant_no: number | null
  /** Active `thumb640` generation of the version's master: the real thumbnail. */
  thumb_generation: string | null
  /** Master and source hashes of the version, hex: its previews are found by them. */
  master_hex: string
  source_hex: string | null
}

/** The sub-handle of a file: `master`, `teaser`, `pic07`, `ed07`, `u2` (naming §3, §5). */
export function handleOf(
  role: MembershipRow['role'],
  ordinal: number | null,
  variantNo: number,
): string {
  if (variantNo > 0) return `u${variantNo}`
  if (ordinal === null) return role
  return `${role}${String(ordinal).padStart(2, '0')}`
}

/** Live memberships of objects with the version they show (pinned or current). */
export async function memberships(
  q: Queryable,
  model: ModelScope,
  itemIds: readonly string[],
): Promise<MembershipRow[]> {
  if (itemIds.length === 0) return []
  const { rows } = await q.execute<MembershipRow>(sql`
    SELECT im.id, im.item_id, im.asset_id, im.kind, im.role, im.ordinal, im.variant_no,
           im.display_position, im.selected, im.life_use, im.row_version::int AS row_version,
           a.media_kind, a.uniq_level, v.id AS version_id, v.version_no,
           v.duration_ms::float8 AS duration_ms, v.width, v.height,
           b.byte_size::float8 AS byte_size, b.ext,
           (v.created_at AT TIME ZONE 'Europe/Moscow')::date::text AS created_at,
           owner.item_id AS owner_item_id, owner.role AS owner_role,
           owner.ordinal AS owner_ordinal, owner.variant_no AS owner_variant_no,
           (SELECT g.id FROM rendition_generations g
             WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
               AND g.state = 'ready' AND NOT g.meta_stripped
             LIMIT 1) AS thumb_generation,
           encode(v.master_sha256, 'hex') AS master_hex, encode(v.source_sha256, 'hex') AS source_hex
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id
                           AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
      JOIN blobs b ON b.sha256 = v.master_sha256
      LEFT JOIN item_memberships owner
        ON im.kind = 'reference' AND owner.model_id = im.model_id
       AND owner.asset_id = im.asset_id AND owner.kind = 'owned' AND owner.removed_at IS NULL
     WHERE im.model_id = ${model.id}::uuid AND im.item_id = ANY(${sql.param([...itemIds])}::uuid[])
       AND im.removed_at IS NULL
     ORDER BY im.display_position NULLS LAST, im.role, im.ordinal NULLS FIRST, im.variant_no,
              im.id`)
  return rows
}

interface VersionRow extends Record<string, unknown> {
  id: string
  asset_id: string
  version_no: number
  on: string
  duration_ms: number | null
  width: number | null
  height: number | null
  media_kind: 'video' | 'image'
  master_hex: string
  source_hex: string | null
  thumb_generation: string | null
}

const ORDINAL_LABEL: Partial<Record<FileRole, string>> = {
  photo: 'фото',
  clip: 'видео',
  raw: 'файл',
}

/** Role of the contract: `pic` is a photo, a FYP master is the montage, a reference is material. */
function fileRole(type: DbItemType, row: MembershipRow): FileRole {
  if (row.kind === 'reference') return 'promo_link'
  switch (row.role) {
    case 'master':
      return type === 'FYP' ? 'montage' : 'master'
    case 'teaser':
      return 'teaser'
    case 'clip':
      return 'clip'
    case 'raw':
      return type === 'RAW' ? 'raw' : 'photo'
    default:
      return 'photo'
  }
}

/** Ordered files (photos, frames, clips, materials) count 1… in the order of the object. */
const ORDERED_ROLES = new Set<MembershipRow['role']>(['pic', 'raw', 'ed', 'clip'])

function fileOf(
  item: ItemRow,
  row: MembershipRow,
  position: number | null,
  versions: readonly FileVersion[],
  processed: ReadonlySet<number>,
  owners: ReadonlyMap<string, ItemRow>,
  model: ModelScope,
  preview: MediaPreview,
): ItemFile {
  const id = publicIdOfRow(item)
  const role = fileRole(item.type, row)
  const key = handleOf(row.role, row.ordinal, row.variant_no)
  const words = ORDINAL_LABEL[role]
  const owner = row.owner_item_id ? owners.get(row.owner_item_id) : undefined
  const ownerId = owner ? publicIdOfRow(owner) : null
  const ownerKey =
    row.owner_role !== null
      ? handleOf(row.owner_role, row.owner_ordinal, row.owner_variant_no ?? 0)
      : null
  return {
    key,
    role,
    label:
      role === 'promo_link'
        ? (ownerId ?? FILE_ROLE_LABEL.promo_link)
        : words && row.ordinal !== null
          ? `${words} ${row.ordinal}`
          : row.role === 'ed'
            ? 'обработанный'
            : FILE_ROLE_LABEL[role],
    media: row.media_kind === 'image' ? 'photo' : 'video',
    position,
    file_name: `${key}.${row.ext}`,
    duration_s: row.duration_ms ? Math.round(row.duration_ms / 1000) : null,
    width: row.width ?? 1080,
    height: row.height ?? 1920,
    size_bytes: row.byte_size,
    thumb: {
      key: `${id}/${key}`,
      ratio: thumbRatio(row.media_kind, row.width, row.height),
      url: renditionUrl(model, row.thumb_generation, 'thumb-640.webp'),
    },
    preview,
    current_version: row.version_no,
    versions: [...versions],
    state: { kind: 'ready' },
    selected: item.type === 'SET' ? row.selected : null,
    processed:
      item.type === 'SET'
        ? row.role === 'ed' || (row.ordinal !== null && processed.has(row.ordinal))
        : null,
    assignment: item.type === 'LIFE' ? row.life_use : null,
    flags: [],
    shot_at: null,
    source: ownerId && ownerKey ? { item_id: ownerId, file_key: ownerKey } : null,
  }
}

/** Relations of the schema as the contract names them, both ways. */
const RELATION_OUT: Record<string, ProvenanceRelation> = {
  montage_from: 'made_from',
  uniq_from: 'made_from',
  teaser_from: 'made_from',
  frame_from: 'frame_from',
  processed_from: 'frame_from',
  ppv_from_custom: 'ppv_from_custom',
  extracted_from: 'extracted_from',
  split_from: 'extracted_from',
  remaster_from: 'remontage',
  reencoded_from: 'remontage',
  merged_from: 'merged_from',
}

export const RELATION_IN_SCHEMA: Record<ProvenanceRelation, string> = {
  made_from: 'montage_from',
  ppv_from_custom: 'ppv_from_custom',
  remontage: 'remaster_from',
  extracted_from: 'extracted_from',
  merged_from: 'merged_from',
  frame_from: 'frame_from',
}

/** A link nobody confirmed yet (import, a suggestion) is ◆ «Подтвердить / Убрать». */
export const SUGGESTED_BASIS = 'suggested'

interface LinkRow extends Record<string, unknown> {
  id: string
  relation: string
  child_item_id: string
  parent_item_id: string
  basis: string | null
}

export async function provenanceLinks(
  q: Queryable,
  model: ModelScope,
  item: ItemRow,
): Promise<ProvenanceLink[]> {
  const { rows } = await q.execute<LinkRow>(sql`
    SELECT id, relation, child_item_id, parent_item_id, basis FROM provenance
     WHERE model_id = ${model.id}::uuid AND voided_by_id IS NULL
       AND child_item_id IS NOT NULL AND parent_item_id IS NOT NULL
       AND (child_item_id = ${item.id}::uuid OR parent_item_id = ${item.id}::uuid)
     ORDER BY created_at, id`)
  const others = await itemsByIds(
    q,
    model,
    rows.map((row) => (row.child_item_id === item.id ? row.parent_item_id : row.child_item_id)),
  )
  const channels = await promoChannelTitles(q, model)
  return rows.flatMap((row) => {
    const out = row.child_item_id === item.id
    const other = others.get(out ? row.parent_item_id : row.child_item_id)
    if (!other) return []
    const relation = RELATION_OUT[row.relation] ?? 'made_from'
    return [
      {
        id: row.id,
        relation,
        direction: out ? 'out' : 'in',
        item_id: publicIdOfRow(other),
        item_type: itemTypeOfDb(other.type),
        item_title: other.title ?? '',
        extra: other.promo_channel_id ? (channels.get(other.promo_channel_id) ?? null) : null,
        confirmed: row.basis !== SUGGESTED_BASIS,
      } satisfies ProvenanceLink,
    ]
  })
}

async function promoChannelTitles(q: Queryable, model: ModelScope) {
  const { rows } = await q.execute<{ id: string; title: string }>(sql`
    SELECT id, title FROM promo_channels WHERE model_id = ${model.id}::uuid`)
  return new Map(rows.map((row) => [row.id, row.title]))
}

const OLD_NAME_KIND: Record<string, OldName['kind']> = {
  legacy_path: 'folder',
  legacy_name: 'file',
  legacy_id: 'number',
  merged_id: 'number',
  vault_album: 'album',
  registry_row: 'number',
}

/**
 * Where the object lies in its source (DESIGN §4.4 п. 4, §1.1): the folder of the group it was
 * accepted from; for an object of files from elsewhere — the folder of its first file with an
 * old path; a fixture keeps the folder as an alias of the object. Old names are the object's
 * aliases (naming §9).
 */
async function diskOf(
  q: Queryable,
  model: ModelScope,
  item: ItemRow,
): Promise<ItemDetail['ydisk']> {
  const { rows } = await q.execute<{ kind: string; value: string }>(sql`
    SELECT kind, value_raw AS value FROM aliases
     WHERE model_id = ${model.id}::uuid AND item_id = ${item.id}::uuid
       AND kind IN ('legacy_path', 'legacy_name', 'legacy_id', 'merged_id', 'vault_album',
                    'registry_row')
     ORDER BY created_at, id`)
  const folder =
    (await groupFolder(q, model, item)) ??
    (await fileFolder(q, model, item)) ??
    aliasFolder(rows.find((row) => row.kind === 'legacy_path')?.value)
  return {
    ...(folder ? placeOf(folder) : { path: '', url: '' }),
    source: folder?.source ?? null,
    old_names: rows.map((row) => ({
      name: row.value,
      kind: OLD_NAME_KIND[row.kind] ?? 'number',
      with_fan_name: false,
    })),
  }
}

interface SourceFolder {
  source: 'ydisk' | 'dropbox'
  /** The folder as the source's API names it: `disk:/1. PPV/…` or `/1. PPV/…`. */
  path: string
  /** The model's root in that source (`disk:/`, `/Lora`): the path in words starts below it. */
  root?: string | null
  /** An archive, not a folder: the words name it, the link opens the folder it lies in. */
  file?: boolean
}

const CLOUD: Record<string, SourceFolder['source']> = { yandex_disk: 'ydisk', dropbox: 'dropbox' }

/**
 * The folder of the group the object was accepted from, if it came from a cloud source: the
 * folder object's current path (a folder group — the folder itself, a day's loose files — the
 * folder they lie in; renames on the disk follow), else the path the group was found at.
 */
async function groupFolder(q: Queryable, model: ModelScope, item: ItemRow) {
  const { rows } = await q.execute<{
    current: string | null
    is_dir: boolean | null
    path: string | null
    grouping: string
    kind: string
    root: string | null
  }>(sql`
    SELECT o.current_path AS current, o.is_dir, g.evidence ->> 'path' AS path, g.grouping,
           s.kind, s.root_path AS root
      FROM content_items c
      JOIN inbox_groups g ON g.model_id = c.model_id AND g.id = c.created_from_group_id
      JOIN sources s ON s.model_id = g.model_id AND s.id = g.source_id
      LEFT JOIN source_objects o ON o.model_id = g.model_id AND o.id = g.folder_object_id
     WHERE c.model_id = ${model.id}::uuid AND c.id = ${item.id}::uuid`)
  const row = rows[0]
  const source = row ? CLOUD[row.kind] : undefined
  if (!row || !source) return null
  const path =
    row.current ?? (row.grouping === 'folder' ? row.path : row.path && folderOf(row.path))
  return path ? { source, path, root: row.root, file: row.is_dir === false } : null
}

function folderOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : path
}

/** The folder of the object's first file that keeps an old path of a cloud source. */
async function fileFolder(q: Queryable, model: ModelScope, item: ItemRow) {
  const { rows } = await q.execute<{ path: string; kind: string; root: string | null }>(sql`
    SELECT a.value_raw AS path, s.kind, s.root_path AS root
      FROM item_memberships m
      JOIN aliases a ON a.model_id = m.model_id AND a.asset_id = m.asset_id
                    AND a.kind = 'legacy_path'
      JOIN source_objects o ON o.model_id = a.model_id AND o.id = a.source_object_id
      JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
     WHERE m.model_id = ${model.id}::uuid AND m.item_id = ${item.id}::uuid
       AND s.kind IN ('yandex_disk', 'dropbox')
     ORDER BY a.created_at, a.id
     LIMIT 1`)
  const row = rows[0]
  const source = row ? CLOUD[row.kind] : undefined
  if (!row || !source) return null
  return { source, path: folderOf(row.path), root: row.root }
}

/** A folder kept as the object's own alias (fixtures, early imports): the old Я.Диск. */
function aliasFolder(path: string | undefined): SourceFolder | null {
  return path ? { source: 'ydisk', path } : null
}

/**
 * «1. PPV / Bundles / [PPV-073]_birthday_07.08.26» and the folder in the source's web client:
 * Я.Диск — `disk.yandex.ru/client/disk/<path>`, Dropbox — `dropbox.com/home/<path>`.
 */
export function placeOf(folder: SourceFolder): { path: string; url: string } {
  const split = (path: string) =>
    path
      .replace(/^disk:/, '')
      .split('/')
      .filter((part) => part.length > 0)
  const parts = split(folder.path)
  const root = split(folder.root ?? '')
  const below = root.every((part, index) => parts[index] === part)
    ? parts.slice(root.length)
    : parts
  const encoded = (folder.file ? parts.slice(0, -1) : parts).map(encodeURIComponent).join('/')
  return {
    path: below.join(' / '),
    url:
      folder.source === 'dropbox'
        ? `https://www.dropbox.com/home/${encoded}`
        : `https://disk.yandex.ru/client/disk/${encoded}`,
  }
}

async function lifecycleOf(q: Queryable, model: ModelScope, item: ItemRow): Promise<ItemLifecycle> {
  if (!item.deleted_at) return { state: 'active' }
  if (item.merged_into_item_id) {
    const into = (await itemsByIds(q, model, [item.merged_into_item_id])).get(
      item.merged_into_item_id,
    )
    if (into) return { state: 'merged', into: publicIdOfRow(into), at: instant(item.deleted_at) }
  }
  const names = await principalNames(q, item.deleted_by ? [item.deleted_by] : [])
  return {
    state: 'deleted',
    at: instant(item.deleted_at),
    by: (item.deleted_by && names.get(item.deleted_by)) || 'Система',
  }
}

/** A tombstone is not in `catalog_index`: its entry is put together from the row and files. */
function tombstoneEntry(item: ItemRow, files: readonly ItemFile[]): CatalogEntry {
  const id = publicIdOfRow(item)
  const type = itemTypeOfDb(item.type)
  const master = files.find((file) => file.role === 'master' || file.role === 'montage')
  return {
    id,
    type,
    title: item.title ?? '',
    title_en: item.title_en,
    tags: [],
    markup: 'draft',
    cover: { key: id, ratio: master ? master.thumb.ratio : '3:4' },
    duration_s: master?.duration_s ?? null,
    photo_count: files.filter((file) => file.media === 'photo').length,
    video_count: files.filter((file) => file.media === 'video').length,
    version_count: master?.current_version ?? 1,
    has_teaser: files.some((file) => file.role === 'teaser'),
    arrived_on: (item.deleted_at ?? '').slice(0, 10),
    shot_on: null,
    ppv_kind: item.ppv_kind,
    raw_purpose: rawPurposeOf(item.raw_purpose),
    ppv_made_as: null,
    fan_name: type === 'custom' ? item.name_in_media : null,
    second_person: item.has_second_person,
    delivered_on: null,
    selected_count: null,
    processed_count: null,
    life_unassigned: null,
    life_chat_count: null,
    life_feed_count: null,
    steady_content: false,
    photo_custom: false,
    aliases: [],
    order_id: null,
    channel: null,
    size_bytes: null,
  }
}

/**
 * «Кадры мастера»: up to ten annotation frames of the master's active `frames` generation at
 * equal steps, with their moments (SPEC §9.3 `frames/NNNN.webp`); none until it is built.
 */
async function masterFrames(
  q: Queryable,
  model: ModelScope,
  publicId: string,
  rows: readonly MembershipRow[],
): Promise<MasterFrame[]> {
  const master = rows.find(
    (row) => row.kind === 'owned' && row.role === 'master' && row.media_kind === 'video',
  )
  if (!master) return []
  const { rows: frames } = await q.execute<{
    generation: string
    name: string
    frame_ms: number
  }>(sql`
    SELECT g.id AS generation, a.name, a.frame_ms::float8 AS frame_ms
      FROM asset_versions v
      JOIN rendition_generations g ON g.master_sha256 = v.master_sha256 AND g.kind = 'frames'
                                  AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped
      JOIN rendition_artifacts a ON a.generation_id = g.id AND a.state = 'ready'
     WHERE v.model_id = ${model.id}::uuid AND v.id = ${master.version_id}::uuid
     ORDER BY a.frame_ms, a.name`)
  if (frames.length === 0) return []
  const step = Math.max(1, frames.length / 10)
  const picked = Array.from(
    { length: Math.min(10, frames.length) },
    (_, i) => frames[Math.floor(i * step)] as (typeof frames)[number],
  )
  const ratio = thumbRatio('video', master.width, master.height)
  return picked.map((frame, i) => ({
    t_s: Math.round((frame.frame_ms ?? 0) / 100) / 10,
    thumb: {
      key: `${publicId}/frame${String(i + 1).padStart(2, '0')}`,
      ratio,
      url: renditionUrl(model, frame.generation, frame.name),
    },
  }))
}

/** Frames of each version for «Сравнить v1 / v2» (DESIGN §3.5): as many as the compare shows. */
const COMPARE_FRAMES = 6

/**
 * Frames of video versions at the same timecodes — equal steps over the longest version, put on
 * its frames and without repeats (a short clip has few) — each the nearest annotation frame of
 * its version (SPEC §9.3 `frames/NNNN.webp`, every few seconds).
 */
async function alignedFrames(
  q: Queryable,
  model: ModelScope,
  publicId: string,
  versions: readonly VersionRow[],
): Promise<Map<string, MasterFrame[]>> {
  const out = new Map<string, MasterFrame[]>()
  if (versions.length === 0) return out
  const { rows } = await q.execute<{
    version_id: string
    generation: string
    name: string
    frame_ms: number
  }>(sql`
    SELECT v.id AS version_id, g.id AS generation, a.name, a.frame_ms::float8 AS frame_ms
      FROM asset_versions v
      JOIN rendition_generations g ON g.master_sha256 = v.master_sha256 AND g.kind = 'frames'
                                  AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped
      JOIN rendition_artifacts a ON a.generation_id = g.id AND a.state = 'ready'
     WHERE v.model_id = ${model.id}::uuid
       AND v.id = ANY(${sql.param(versions.map((version) => version.id))}::uuid[])
       AND a.frame_ms IS NOT NULL
     ORDER BY v.id, a.frame_ms`)
  type FrameRow = (typeof rows)[number]
  const framesOf = new Map<string, FrameRow[]>()
  for (const row of rows)
    framesOf.set(row.version_id, [...(framesOf.get(row.version_id) ?? []), row])
  const nearest = (frames: readonly FrameRow[], moment: number) =>
    frames.reduce((best, frame) =>
      Math.abs(frame.frame_ms - moment) < Math.abs(best.frame_ms - moment) ? frame : best,
    )
  const longest = Math.max(...versions.map((version) => version.duration_ms ?? 0))
  const reference = [...versions]
    .filter((version) => framesOf.has(version.id))
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))[0]
  if (!reference) return out
  const own = framesOf.get(reference.id) ?? []
  const span = longest || Math.max(...own.map((frame) => frame.frame_ms))
  const moments = [
    ...new Set(
      Array.from(
        { length: COMPARE_FRAMES },
        (_, i) => nearest(own, (span * (i + 0.5)) / COMPARE_FRAMES).frame_ms,
      ),
    ),
  ]
  for (const version of versions) {
    const frames = framesOf.get(version.id)
    if (!frames) continue
    const ratio = thumbRatio('video', version.width, version.height)
    const end = version.duration_ms ?? Number.POSITIVE_INFINITY
    out.set(
      version.id,
      moments
        .filter((moment) => moment <= end)
        .map((moment, i) => {
          const frame = nearest(frames, moment)
          return {
            t_s: Math.round(frame.frame_ms / 100) / 10,
            thumb: {
              key: `${publicId}/frame${String(i + 1).padStart(2, '0')}-v${version.version_no}`,
              ratio,
              url: renditionUrl(model, frame.generation, frame.name),
            },
          }
        }),
    )
  }
  return out
}

/**
 * Versions of the object's files. A file with one version gets the bare line; a file with more
 * — a remontage, a fix — gets each version's thumbnail and preview, and a video its frames for
 * the compare, so the viewer shows the version itself, not the current one.
 */
async function fileVersions(
  q: Queryable,
  model: ModelScope,
  publicId: string,
  assetIds: readonly string[],
): Promise<Map<string, FileVersion[]>> {
  const { rows } = await q.execute<VersionRow>(sql`
    SELECT v.id, v.asset_id, v.version_no,
           (v.created_at AT TIME ZONE 'Europe/Moscow')::date::text AS on,
           v.duration_ms::float8 AS duration_ms, v.width, v.height, a.media_kind,
           encode(v.master_sha256, 'hex') AS master_hex, encode(v.source_sha256, 'hex') AS source_hex,
           (SELECT g.id FROM rendition_generations g
             WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
               AND g.state = 'ready' AND NOT g.meta_stripped
             LIMIT 1) AS thumb_generation
      FROM asset_versions v JOIN assets a ON a.model_id = v.model_id AND a.id = v.asset_id
     WHERE v.model_id = ${model.id}::uuid
       AND v.asset_id = ANY(${sql.param([...assetIds])}::uuid[])
     ORDER BY v.asset_id, v.version_no`)
  const count = new Map<string, number>()
  for (const row of rows) count.set(row.asset_id, (count.get(row.asset_id) ?? 0) + 1)
  const several = rows.filter((row) => (count.get(row.asset_id) ?? 0) > 1)
  const previews = await mediaPreviews(
    q,
    model,
    several.map((row) => ({
      media: row.media_kind,
      master: row.master_hex,
      source: row.source_hex,
    })),
  )
  const media = new Map(several.map((row, i) => [row.id, previews[i] as MediaPreview]))
  const frames = await alignedFrames(
    q,
    model,
    publicId,
    several.filter((row) => row.media_kind === 'video'),
  )
  const out = new Map<string, FileVersion[]>()
  for (const row of rows) {
    const preview = media.get(row.id)
    const version: FileVersion = {
      no: row.version_no,
      on: row.on,
      reason: null,
      duration_s: row.duration_ms ? Math.round(row.duration_ms / 1000) : null,
      ...(preview
        ? {
            thumb: {
              key: `${publicId}/${row.asset_id}-v${row.version_no}`,
              ratio: thumbRatio(row.media_kind, row.width, row.height),
              url: renditionUrl(model, row.thumb_generation, 'thumb-640.webp'),
            },
            preview,
            ...(row.media_kind === 'video' ? { frames: frames.get(row.id) ?? [] } : {}),
          }
        : {}),
    }
    out.set(row.asset_id, [...(out.get(row.asset_id) ?? []), version])
  }
  return out
}

export async function itemDetail(q: Queryable, model: ModelScope, id: string): Promise<ItemDetail> {
  const item = await findItem(q, model, id, { withTombstones: true })
  const rows = await memberships(q, model, [item.id])
  const versions = await fileVersions(
    q,
    model,
    publicIdOfRow(item),
    rows.map((row) => row.asset_id),
  )
  const owners = await itemsByIds(
    q,
    model,
    rows.flatMap((row) => (row.owner_item_id ? [row.owner_item_id] : [])),
  )
  const processed = new Set(
    rows.flatMap((row) => (row.role === 'ed' && row.ordinal !== null ? [row.ordinal] : [])),
  )
  const base = rows.filter((row) => !(row.kind === 'owned' && row.variant_no > 0))
  const previews = await mediaPreviews(
    q,
    model,
    base.map((row) => ({ media: row.media_kind, master: row.master_hex, source: row.source_hex })),
  )
  let rank = 0
  const files = base.map((row, i) =>
    fileOf(
      item,
      row,
      ORDERED_ROLES.has(row.role) ? ++rank : null,
      versions.get(row.asset_id) ?? [],
      processed,
      owners,
      model,
      previews[i] as MediaPreview,
    ),
  )
  const variants = rows.filter((row) => row.kind === 'owned' && row.variant_no > 0)
  const variantPreviews = await mediaPreviews(
    q,
    model,
    variants.map((row) => ({ media: 'video', master: row.master_hex, source: row.source_hex })),
  )
  const fypVersions: FypVersion[] = variants.map((row, i) => ({
    no: row.variant_no,
    level: row.uniq_level ?? 'soft',
    thumb: {
      key: `${publicIdOfRow(item)}/u${row.variant_no}`,
      ratio: '9:16',
      url: renditionUrl(model, row.thumb_generation, 'thumb-640.webp'),
    },
    preview: variantPreviews[i] as MediaPreview,
    duration_s: row.duration_ms ? Math.round(row.duration_ms / 1000) : 0,
    placed: [],
  }))
  const [entry] = item.deleted_at
    ? [tombstoneEntry(item, files)]
    : await catalogEntries(q, model, sql`AND c.item_id = ${item.id}::uuid`)
  if (!entry) throw new Error(`catalog_index has no row for ${id}`)
  const markup = await markupFields(q, model, [
    {
      uid: item.id,
      type: item.type,
      title: item.title,
      title_en: item.title_en,
      description: item.description,
    },
  ])
  const order = item.type === 'CUS' ? await itemOrderSummary(q, model, item.id) : null
  const plan = await loadState(q, model, { rows: sql`AND r.item_id = ${item.id}::uuid` })
  const versionsPlaced = versionPlacements(plan, item.id)
  return {
    entry: { ...entry, id: publicIdOf(item.type, item.number) },
    version: item.row_version,
    lifecycle: await lifecycleOf(q, model, item),
    files,
    frames: await masterFrames(q, model, publicIdOfRow(item), base),
    fyp_versions: fypVersions.map((version) => ({
      ...version,
      placed: versionsPlaced.get(version.no) ?? [],
    })),
    markup: markup.get(item.id) ?? [],
    provenance: await provenanceLinks(q, model, item),
    ydisk: await diskOf(q, model, item),
    pages: itemPages(plan, { ...entry, id: publicIdOf(item.type, item.number) }, item.id),
    order: order ? { id: order.id, title: order.title, status: order.status } : null,
    handoffs:
      item.type === 'PRM'
        ? (await handoffsOf(q, model, { packages: [item.id] })).map(({ id, status }) => ({
            id,
            status,
          }))
        : [],
    promo: await itemPromo(q, model, item.id),
    receipts: [],
    // A video custom without a PPV whose order is delivered and has no open revision.
    ready_for_ppv:
      order !== null &&
      (order.state === 'delivered' || order.state === 'closed') &&
      !entry.photo_custom &&
      entry.ppv_made_as === null,
    frame_check: null,
    ppv_montage: null,
  }
}
