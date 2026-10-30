import type { CatalogEntry } from '@contentops/contracts/domain/catalog'
import type { MasterFrame } from '@contentops/contracts/domain/files'
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
             LIMIT 1) AS thumb_generation
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
  asset_id: string
  version_no: number
  on: string
  duration_ms: number | null
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
  versions: readonly VersionRow[],
  processed: ReadonlySet<number>,
  owners: ReadonlyMap<string, ItemRow>,
  model: ModelScope,
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
    current_version: row.version_no,
    versions: versions
      .filter((version) => version.asset_id === row.asset_id)
      .map((version) => ({
        no: version.version_no,
        on: version.on,
        reason: null,
        duration_s: version.duration_ms ? Math.round(version.duration_ms / 1000) : null,
      })),
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

/** Я.Диск: the source folder of the object and its old names (aliases, naming §9). */
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
  const path = rows.find((row) => row.kind === 'legacy_path')?.value ?? ''
  return {
    path,
    url: path ? `https://disk.yandex.ru/client/disk/${encodeURIComponent(path)}` : '',
    old_names: rows.map((row) => ({
      name: row.value,
      kind: OLD_NAME_KIND[row.kind] ?? 'number',
      with_fan_name: false,
    })),
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
    second_person: item.has_second_person === true,
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

export async function itemDetail(q: Queryable, model: ModelScope, id: string): Promise<ItemDetail> {
  const item = await findItem(q, model, id, { withTombstones: true })
  const rows = await memberships(q, model, [item.id])
  const { rows: versions } = await q.execute<VersionRow>(sql`
    SELECT asset_id, version_no, (created_at AT TIME ZONE 'Europe/Moscow')::date::text AS on,
           duration_ms::float8 AS duration_ms
      FROM asset_versions
     WHERE model_id = ${model.id}::uuid
       AND asset_id = ANY(${sql.param(rows.map((row) => row.asset_id))}::uuid[])
     ORDER BY asset_id, version_no`)
  const owners = await itemsByIds(
    q,
    model,
    rows.flatMap((row) => (row.owner_item_id ? [row.owner_item_id] : [])),
  )
  const processed = new Set(
    rows.flatMap((row) => (row.role === 'ed' && row.ordinal !== null ? [row.ordinal] : [])),
  )
  const base = rows.filter((row) => !(row.kind === 'owned' && row.variant_no > 0))
  let rank = 0
  const files = base.map((row) =>
    fileOf(
      item,
      row,
      ORDERED_ROLES.has(row.role) ? ++rank : null,
      versions,
      processed,
      owners,
      model,
    ),
  )
  const fypVersions: FypVersion[] = rows
    .filter((row) => row.kind === 'owned' && row.variant_no > 0)
    .map((row) => ({
      no: row.variant_no,
      level: row.uniq_level ?? 'soft',
      thumb: {
        key: `${publicIdOfRow(item)}/u${row.variant_no}`,
        ratio: '9:16',
        url: renditionUrl(model, row.thumb_generation, 'thumb-640.webp'),
      },
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
