import { mskDate } from '@contentops/contracts/clock'
import type { ActorRef, LocalDate, ThumbRef } from '@contentops/contracts/domain/common'
import type { ItemId } from '@contentops/contracts/domain/item-type'
import type {
  ChannelContents,
  CollectionMember,
  Contractor,
  ContractorFormat,
  Handoff,
  HandoffOverlap,
  HandoffState,
  ItemPromo,
  PromoChannel,
  PromoCollection,
} from '@contentops/contracts/domain/promo'
import { PROMO_MANIFEST_NAME } from '@contentops/contracts/download-name'
import { formatBytes } from '@contentops/contracts/format'
import { computeHandoffOverlap } from '@contentops/contracts/handoff-overlap'
import { computeHandoffStatus } from '@contentops/contracts/handoff-status'
import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { renditionUrl, thumbRatio } from '../catalog/entries'
import { findItem, type ItemRow, publicIdOf } from '../catalog/ids'
import { instant, isUuid } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import { downloadUrl } from '../media/downloads'

/**
 * «Промо» as the screens read it (SPEC §7.1, DESIGN §4.17): channel folders, collections as
 * a view of the catalog, materials with «передавали» and «ещё в подборках», handoffs with
 * their state, the check «уже передавали». A collection is a `PRM` object, its materials are
 * memberships; a material is named by the file it points at (`RAW-0213/raw03`).
 */

/** Today in Europe/Moscow: dates on the screen drop the year inside the current one. */
export function today(): LocalDate {
  return mskDate(new Date().toISOString())
}

const MOSAIC = 4

/** YouTube shows landscape frames (DESIGN §4.17); the other channels are vertical. */
function orientationOf(code: string): PromoChannel['orientation'] {
  return code === 'youtube' ? 'landscape' : 'vertical'
}

/** `master`, `pic03`, `u2` — the handle of a file in its object (naming §3). */
export function handleOf(role: string, ordinal: number | null, variantNo: number): string {
  if (variantNo > 0) return `u${variantNo}`
  return ordinal === null ? role : `${role}${String(ordinal).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** A live membership of a collection with the file it shows (pinned or current version). */
export interface MaterialRow extends Record<string, unknown> {
  membership_id: string
  package_id: string
  kind: 'owned' | 'reference'
  role: string
  ordinal: number | null
  variant_no: number
  display_position: number | null
  added_at: string
  added_on: string
  asset_id: string
  media_kind: 'video' | 'image'
  version_id: string
  version_no: number
  duration_ms: number | null
  width: number | null
  height: number | null
  byte_size: number
  blob_state: string
  owner_type: string
  owner_number: number
  owner_role: string
  owner_ordinal: number | null
  owner_variant_no: number
  uploaded_on: string
  thumb_generation: string | null
}

/** The materials of collections, or of every collection of a channel. */
export async function materialRows(
  q: Queryable,
  model: ModelScope,
  scope: { packages: readonly string[] } | { channel: string },
): Promise<MaterialRow[]> {
  const where =
    'packages' in scope
      ? sql`im.item_id = ANY(${sql.param([...scope.packages])}::uuid[])`
      : sql`p.promo_channel_id = ${scope.channel}::uuid`
  if ('packages' in scope && scope.packages.length === 0) return []
  const { rows } = await q.execute<MaterialRow>(sql`
    SELECT im.id AS membership_id, im.item_id AS package_id, im.kind, im.role, im.ordinal,
           im.variant_no, im.display_position, im.added_at::text AS added_at,
           (im.added_at AT TIME ZONE 'Europe/Moscow')::date::text AS added_on,
           a.id AS asset_id, a.media_kind, v.id AS version_id, v.version_no,
           v.duration_ms::float8 AS duration_ms, v.width, v.height,
           b.byte_size::float8 AS byte_size, b.state AS blob_state,
           oi.type AS owner_type, oi.number AS owner_number, owner.role AS owner_role,
           owner.ordinal AS owner_ordinal, owner.variant_no AS owner_variant_no,
           (coalesce(r.remote_created_at, v.created_at) AT TIME ZONE 'Europe/Moscow')::date::text
             AS uploaded_on,
           (SELECT g.id FROM rendition_generations g
             WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
               AND g.state = 'ready' AND NOT g.meta_stripped
             LIMIT 1) AS thumb_generation
      FROM item_memberships im
      JOIN content_items p ON p.model_id = im.model_id AND p.id = im.item_id
                          AND p.type = 'PRM' AND p.deleted_at IS NULL
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id
                           AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
      JOIN blobs b ON b.sha256 = v.master_sha256
      LEFT JOIN source_revisions r ON r.model_id = v.model_id AND r.id = v.source_revision_id
      -- The file's own object and handle: a reference names the file it points at.
      JOIN LATERAL (
        SELECT o.item_id, o.role, o.ordinal, o.variant_no FROM item_memberships o
         WHERE o.model_id = im.model_id AND o.asset_id = im.asset_id AND o.kind = 'owned'
         ORDER BY o.removed_at NULLS FIRST, o.added_at DESC
         LIMIT 1
      ) owner ON true
      JOIN content_items oi ON oi.model_id = im.model_id AND oi.id = owner.item_id
     WHERE im.model_id = ${model.id}::uuid AND im.removed_at IS NULL AND ${where}
     ORDER BY im.item_id, im.display_position NULLS LAST, im.added_at, im.id`)
  return rows
}

/** `RAW-0213/raw03`: the source object and the file's handle in it. */
export function materialKey(row: MaterialRow): { item_id: ItemId; file_key: string } {
  return {
    item_id: publicIdOf(row.owner_type, row.owner_number),
    file_key: handleOf(row.owner_role, row.owner_ordinal, row.owner_variant_no),
  }
}

function thumbOf(model: ModelScope, row: MaterialRow): ThumbRef {
  const key = materialKey(row)
  return {
    key: `${key.item_id}/${key.file_key}`,
    ratio: thumbRatio(row.media_kind, row.width, row.height),
    url: renditionUrl(model, row.thumb_generation, 'thumb-640.webp'),
  }
}

interface Handed {
  contractor_id: string
  contractor: string
  collection_id: ItemId
  on: LocalDate
}

/**
 * Handoffs that carried each file, oldest first: sent ones (imported packs too) — «передавали»;
 * or, with `pending`, prepared ones nobody marked «Передано» yet (a replaced one is not).
 */
async function handedOut(
  q: Queryable,
  model: ModelScope,
  assets: readonly string[],
  pending = false,
): Promise<Map<string, Handed[]>> {
  const result = new Map<string, Handed[]>()
  if (assets.length === 0) return result
  const which = pending
    ? sql`d.state <> 'sent' AND NOT EXISTS (SELECT 1 FROM promo_deliveries n
                                             WHERE n.model_id = d.model_id AND n.corrects_id = d.id)`
    : sql`d.state = 'sent'`
  const { rows } = await q.execute<{
    asset_id: string
    contractor_id: string
    contractor: string
    type: string
    number: number
    on: string
  }>(sql`
    SELECT DISTINCT e.asset_id, d.contractor_id, c.name AS contractor, p.type, p.number,
           coalesce((d.sent_at AT TIME ZONE 'Europe/Moscow')::date::text,
                    d.summary ->> 'folder_date',
                    (coalesce(d.prepared_at, d.created_at) AT TIME ZONE 'Europe/Moscow')::date::text)
             AS on
      FROM promo_deliveries d
      JOIN asset_manifest_entries e ON e.model_id = d.model_id AND e.manifest_id = d.manifest_id
      JOIN contractors c ON c.model_id = d.model_id AND c.id = d.contractor_id
      JOIN content_items p ON p.model_id = d.model_id AND p.id = d.package_item_id
     WHERE d.model_id = ${model.id}::uuid AND ${which}
       AND e.asset_id = ANY(${sql.param([...new Set(assets)])}::uuid[])
     ORDER BY 6, 4, 5`)
  for (const row of rows) {
    const list = result.get(row.asset_id) ?? []
    list.push({
      contractor_id: row.contractor_id,
      contractor: row.contractor,
      collection_id: publicIdOf(row.type, row.number),
      on: row.on,
    })
    result.set(row.asset_id, list)
  }
  return result
}

/** «Ещё в подборках»: live collections holding each file (`PRM-012`; the screen adds the channel). */
async function collectionsOf(
  q: Queryable,
  model: ModelScope,
  assets: readonly string[],
): Promise<Map<string, { package_id: string; id: ItemId }[]>> {
  const result = new Map<string, { package_id: string; id: ItemId }[]>()
  if (assets.length === 0) return result
  const { rows } = await q.execute<{
    asset_id: string
    package_id: string
    type: string
    number: number
  }>(sql`
    SELECT im.asset_id, p.id AS package_id, p.type, p.number
      FROM item_memberships im
      JOIN content_items p ON p.model_id = im.model_id AND p.id = im.item_id
                          AND p.type = 'PRM' AND p.deleted_at IS NULL
     WHERE im.model_id = ${model.id}::uuid AND im.removed_at IS NULL
       AND im.asset_id = ANY(${sql.param([...new Set(assets)])}::uuid[])
     ORDER BY p.number`)
  for (const row of rows) {
    const list = result.get(row.asset_id) ?? []
    list.push({ package_id: row.package_id, id: publicIdOf(row.type, row.number) })
    result.set(row.asset_id, list)
  }
  return result
}

/** Materials as the screens show them, with their history and other collections. */
export async function membersOf(
  q: Queryable,
  model: ModelScope,
  rows: readonly MaterialRow[],
): Promise<CollectionMember[]> {
  const assets = rows.map((row) => row.asset_id)
  const [handed, pending, elsewhere] = await Promise.all([
    handedOut(q, model, assets),
    handedOut(q, model, assets, true),
    collectionsOf(q, model, assets),
  ])
  return rows.map((row) => ({
    ...materialKey(row),
    media: row.media_kind === 'video' ? 'video' : 'photo',
    thumb: thumbOf(model, row),
    size_bytes: Math.round(row.byte_size),
    duration_s:
      row.media_kind === 'video' && row.duration_ms !== null
        ? Math.round(row.duration_ms / 1000)
        : null,
    uploaded_on: row.uploaded_on,
    added_on: row.added_on,
    handed_to: handed.get(row.asset_id) ?? [],
    prepared_for: pending.get(row.asset_id) ?? [],
    other_collections: (elsewhere.get(row.asset_id) ?? [])
      .filter((other) => other.package_id !== row.package_id)
      .map((other) => other.id),
  }))
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

interface DeliveryRow extends Record<string, unknown> {
  id: string
  package_id: string
  package_type: string
  package_number: number
  package_title: string | null
  contractor_id: string
  contractor_name: string
  format: ContractorFormat | null
  state: 'preparing' | 'prepared' | 'sent'
  origin: 'product' | 'import'
  summary: HandoffSummary
  receipt_id: string | null
  meta_stripped: boolean | null
  created_at: string
  sent_on: string | null
  actor_id: string | null
  actor_name: string | null
  actor_kind: 'human' | 'agent' | null
  actor_gender: 'f' | 'm' | null
}

/** What `promo_deliveries.summary` keeps (schema §3.8). */
export interface HandoffSummary {
  meta_stripped?: boolean
  video_count?: number
  photo_count?: number
  /** Before the build: the masters and ready copies («≈2,6 ГБ»). */
  estimated_bytes?: number
  /** After the build: the files as issued, without the ZIP's own records. */
  size_bytes?: number
  zip_bytes?: number
  zip_name?: string
  /** An imported pack: the date of its folder, a claim (SPEC §6.3). */
  folder_date?: string
}

interface WorkRow extends Record<string, unknown> {
  id: string
  manifest_id: string
  state: string
  progress_num: string | null
  progress_den: string | null
  error_text: string | null
}

const SYSTEM: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

async function deliveryRows(
  q: Queryable,
  model: ModelScope,
  filter: { packages?: readonly string[]; ids?: readonly string[] },
): Promise<DeliveryRow[]> {
  const where = filter.packages
    ? sql`AND d.package_item_id = ANY(${sql.param([...filter.packages])}::uuid[])`
    : filter.ids
      ? sql`AND d.id = ANY(${sql.param([...filter.ids])}::uuid[])`
      : sql``
  const { rows } = await q.execute<DeliveryRow>(sql`
    SELECT d.id, d.package_item_id AS package_id, p.type AS package_type,
           p.number AS package_number, p.title AS package_title, d.contractor_id,
           c.name AS contractor_name, d.format, d.state, d.origin, d.summary, d.receipt_id,
           r.meta_stripped, d.created_at::text AS created_at,
           coalesce((d.sent_at AT TIME ZONE 'Europe/Moscow')::date::text,
                    CASE WHEN d.state = 'sent' THEN d.summary ->> 'folder_date' END) AS sent_on,
           pr.id AS actor_id, pr.display_name AS actor_name, pr.kind AS actor_kind,
           pr.gender AS actor_gender
      FROM promo_deliveries d
      JOIN content_items p ON p.model_id = d.model_id AND p.id = d.package_item_id
      JOIN contractors c ON c.model_id = d.model_id AND c.id = d.contractor_id
      LEFT JOIN download_receipts r ON r.model_id = d.model_id AND r.id = d.receipt_id
      LEFT JOIN principals pr ON pr.id = coalesce(d.sent_by, d.prepared_by)
     WHERE d.model_id = ${model.id}::uuid ${where}
       -- A preparation made again is replaced by its successor.
       AND NOT EXISTS (SELECT 1 FROM promo_deliveries n
                        WHERE n.model_id = d.model_id AND n.corrects_id = d.id)
     ORDER BY d.created_at, d.id`)
  return rows
}

/** Handoffs as the screens show them (DESIGN §5.7); `rows` from `deliveryRows`. */
async function handoffViews(
  q: Queryable,
  model: ModelScope,
  rows: readonly DeliveryRow[],
): Promise<Handoff[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const { rows: entries } = await q.execute<{
    delivery_id: string
    handle: string
    media_kind: string
    master_bytes: number
  }>(sql`
    SELECT d.id AS delivery_id, e.handle_snapshot AS handle, a.media_kind,
           b.byte_size::float8 AS master_bytes
      FROM promo_deliveries d
      JOIN asset_manifest_entries e ON e.model_id = d.model_id AND e.manifest_id = d.manifest_id
      JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
      JOIN asset_versions v ON v.model_id = e.model_id AND v.id = e.asset_version_id
      JOIN blobs b ON b.sha256 = v.master_sha256
     WHERE d.model_id = ${model.id}::uuid AND d.id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY d.id, e.position`)
  const receipts = rows.flatMap((row) => (row.receipt_id ? [row.receipt_id] : []))
  const { rows: files } =
    receipts.length > 0
      ? await q.execute<{ receipt_id: string; file_name: string }>(sql`
          SELECT receipt_id, file_name FROM download_receipt_entries
           WHERE model_id = ${model.id}::uuid AND receipt_id = ANY(${sql.param(receipts)}::uuid[])
           ORDER BY receipt_id, position`)
      : { rows: [] }
  const { rows: works } = await q.execute<WorkRow>(sql`
    SELECT DISTINCT ON (w.manifest_id) w.id, w.manifest_id, w.state, w.progress_num,
           w.progress_den, w.error_text
      FROM promo_deliveries d
      JOIN work_operations w ON w.model_id = d.model_id AND w.manifest_id = d.manifest_id
                            AND w.kind = 'export'
     WHERE d.model_id = ${model.id}::uuid AND d.id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY w.manifest_id, w.created_at DESC`)
  const { rows: manifests } = await q.execute<{ id: string; manifest_id: string }>(sql`
    SELECT id, manifest_id FROM promo_deliveries
     WHERE model_id = ${model.id}::uuid AND id = ANY(${sql.param(ids)}::uuid[])`)
  const manifestOf = new Map(manifests.map((row) => [row.id, row.manifest_id]))
  const workOf = new Map(works.map((work) => [work.manifest_id, work]))
  const day = today()
  return rows.map((row) => {
    const own = entries.filter((entry) => entry.delivery_id === row.id)
    const work = workOf.get(manifestOf.get(row.id) ?? '')
    const failed =
      row.state === 'preparing' && (work?.state === 'failed' || work?.state === 'cancelled')
    const state: HandoffState = failed ? 'failed' : row.state
    const progress =
      state === 'preparing'
        ? work?.progress_num && work.progress_den
          ? Math.min(1, Number(work.progress_num) / Number(work.progress_den))
          : 0
        : state === 'failed'
          ? null
          : 1
    const summary = row.summary ?? {}
    const videos = own.filter((entry) => entry.media_kind === 'video').length
    // An imported pack has no issued files here: its masters stand in for the size.
    const size =
      summary.size_bytes ??
      summary.estimated_bytes ??
      own.reduce((sum, entry) => sum + entry.master_bytes, 0)
    const failure = failed ? (work?.error_text ?? 'ошибка сборки') : null
    const ready = row.state !== 'preparing' && row.receipt_id !== null
    const title = row.package_title ?? publicIdOf(row.package_type, row.package_number)
    const counts = [
      title,
      videos > 0 ? `${videos} видео` : null,
      own.length - videos > 0 ? `${own.length - videos} фото` : null,
      formatBytes(size),
    ]
    return {
      id: row.id,
      collection_id: publicIdOf(row.package_type, row.package_number),
      contractor_id: row.contractor_id,
      contractor_name: row.contractor_name,
      format: row.format,
      state,
      progress,
      video_count: videos,
      photo_count: own.length - videos,
      size_bytes: Math.round(size),
      strip_metadata: row.meta_stripped ?? summary.meta_stripped ?? false,
      created_at: instant(row.created_at),
      sent_on: row.sent_on,
      failure,
      summary_text: counts.filter((part): part is string => part !== null).join(' · '),
      zip_name: ready ? (summary.zip_name ?? null) : null,
      zip_url: ready && row.receipt_id ? downloadUrl(model.code, row.receipt_id) : null,
      member_keys: own.map((entry) => entry.handle),
      zip_files: ready
        ? [
            ...files.filter((file) => file.receipt_id === row.receipt_id).map((f) => f.file_name),
            PROMO_MANIFEST_NAME,
          ]
        : [],
      operation_id: work?.id ?? null,
      recorded_by:
        row.actor_id && row.actor_name
          ? {
              type: row.actor_kind === 'agent' ? 'agent' : 'person',
              id: row.actor_id,
              name: row.actor_name,
              gender: row.actor_gender,
            }
          : SYSTEM,
      status: computeHandoffStatus(
        {
          state,
          contractor_name: row.contractor_name,
          size_bytes: size,
          progress,
          sent_on: row.sent_on,
          failure,
        },
        day,
      ),
    } satisfies Handoff
  })
}

export async function handoffsOf(
  q: Queryable,
  model: ModelScope,
  filter: { packages?: readonly string[]; ids?: readonly string[] } = {},
): Promise<Handoff[]> {
  return handoffViews(q, model, await deliveryRows(q, model, filter))
}

/** One handoff of a collection; a replaced preparation is not found any more. */
export async function handoffOf(
  q: Queryable,
  model: ModelScope,
  id: string,
): Promise<Handoff | undefined> {
  if (!isUuid(id)) return undefined
  return (await handoffsOf(q, model, { ids: [id] }))[0]
}

// ---------------------------------------------------------------------------
// Collections and channels
// ---------------------------------------------------------------------------

/** The collection `PRM-015` of the model; anything else is 404. */
export async function findCollection(
  q: Queryable,
  model: ModelScope,
  id: string,
  options: { lock?: boolean } = {},
): Promise<ItemRow & { channel_code: string; default_contractor_id: string | null }> {
  const item = await findItem(q, model, id, options)
  if (item.type !== 'PRM' || !item.promo_channel_id) {
    throw new ApiProblem('not_found', `${id}: такой подборки нет`, { collection: id })
  }
  const { rows } = await q.execute<{ code: string; default_contractor_id: string | null }>(sql`
    SELECT ch.code, i.default_contractor_id FROM content_items i
      JOIN promo_channels ch ON ch.model_id = i.model_id AND ch.id = i.promo_channel_id
     WHERE i.model_id = ${model.id}::uuid AND i.id = ${item.id}::uuid`)
  return {
    ...item,
    channel_code: rows[0]?.code ?? '',
    default_contractor_id: rows[0]?.default_contractor_id ?? null,
  }
}

type CollectionHead = Omit<PromoCollection, 'members'>

function collectionHead(
  model: ModelScope,
  item: {
    type: string
    number: number
    title: string | null
    default_contractor_id: string | null
  },
  channel: string,
  rows: readonly MaterialRow[],
  handoffs: readonly Handoff[],
): CollectionHead {
  const videos = rows.filter((row) => row.media_kind === 'video').length
  return {
    id: publicIdOf(item.type, item.number),
    title: item.title ?? publicIdOf(item.type, item.number),
    channel,
    video_count: videos,
    photo_count: rows.length - videos,
    size_bytes: Math.round(rows.reduce((sum, row) => sum + row.byte_size, 0)),
    contractor_id: item.default_contractor_id,
    handoffs: [...handoffs],
    covers: rows.slice(0, MOSAIC).map((row) => thumbOf(model, row)),
    status: handoffs.at(-1)?.status ?? null,
  }
}

/** `GET …/promo/collections/<PRM-015>`. */
export async function collectionView(
  q: Queryable,
  model: ModelScope,
  id: string,
): Promise<PromoCollection> {
  const item = await findCollection(q, model, id)
  const rows = await materialRows(q, model, { packages: [item.id] })
  const handoffs = await handoffsOf(q, model, { packages: [item.id] })
  return {
    ...collectionHead(model, item, item.channel_code, rows, handoffs),
    members: await membersOf(q, model, rows),
  }
}

interface ChannelRow extends Record<string, unknown> {
  id: string
  code: string
  title: string
  collection_count: number
  file_count: number
  last_handoff_on: string | null
}

async function channelRows(q: Queryable, model: ModelScope, code?: string): Promise<ChannelRow[]> {
  const { rows } = await q.execute<ChannelRow>(sql`
    SELECT ch.id, ch.code, ch.title,
           (SELECT count(*)::int FROM content_items p
             WHERE p.model_id = ch.model_id AND p.promo_channel_id = ch.id AND p.type = 'PRM'
               AND p.deleted_at IS NULL) AS collection_count,
           (SELECT count(DISTINCT im.asset_id)::int FROM item_memberships im
              JOIN content_items p ON p.model_id = im.model_id AND p.id = im.item_id
             WHERE im.model_id = ch.model_id AND p.promo_channel_id = ch.id AND p.type = 'PRM'
               AND p.deleted_at IS NULL AND im.removed_at IS NULL) AS file_count,
           (SELECT max(coalesce((d.sent_at AT TIME ZONE 'Europe/Moscow')::date::text,
                                d.summary ->> 'folder_date'))
              FROM promo_deliveries d
             WHERE d.model_id = ch.model_id AND d.channel_id = ch.id AND d.state = 'sent')
             AS last_handoff_on
      FROM promo_channels ch
     WHERE ch.model_id = ${model.id}::uuid AND ch.archived_at IS NULL
       ${code === undefined ? sql`` : sql`AND ch.code = ${code}`}
     ORDER BY ch.id`)
  return rows
}

/** The first frames of a channel's newest collections for the folder mosaic. */
async function channelCovers(
  q: Queryable,
  model: ModelScope,
  channels: readonly ChannelRow[],
): Promise<Map<string, ThumbRef[]>> {
  const result = new Map<string, ThumbRef[]>()
  for (const channel of channels) {
    const rows = await materialRows(q, model, { channel: channel.id })
    const newest = [...rows].sort((a, b) => b.added_at.localeCompare(a.added_at))
    const seen = new Set<string>()
    const covers: ThumbRef[] = []
    for (const row of newest) {
      if (seen.has(row.asset_id) || covers.length >= MOSAIC) continue
      seen.add(row.asset_id)
      covers.push(thumbOf(model, row))
    }
    result.set(channel.code, covers)
  }
  return result
}

function channelOf(row: ChannelRow, covers: ThumbRef[]): PromoChannel {
  return {
    id: row.code,
    name: row.title,
    orientation: orientationOf(row.code),
    collection_count: row.collection_count,
    file_count: row.file_count,
    last_handoff_on: row.last_handoff_on,
    covers,
  }
}

export async function channelList(q: Queryable, model: ModelScope): Promise<PromoChannel[]> {
  const rows = await channelRows(q, model)
  const covers = await channelCovers(q, model, rows)
  return rows.map((row) => channelOf(row, covers.get(row.code) ?? []))
}

/** The channel `<code>` of the model, its row; 404 inside the model when there is none. */
export async function findChannel(
  q: Queryable,
  model: ModelScope,
  code: string,
): Promise<{ id: string; code: string; title: string }> {
  const [row] = await channelRows(q, model, code)
  if (!row) throw new ApiProblem('not_found', `Канала ${code} нет`, { channel: code })
  return row
}

/** `GET …/promo/channels/<code>`: collections as folders and every material of the channel. */
export async function channelContents(
  q: Queryable,
  model: ModelScope,
  code: string,
): Promise<ChannelContents> {
  const [row] = await channelRows(q, model, code)
  if (!row) throw new ApiProblem('not_found', `Канала ${code} нет`, { channel: code })
  const { rows: items } = await q.execute<{
    id: string
    type: string
    number: number
    title: string | null
    default_contractor_id: string | null
  }>(sql`
    SELECT id, type, number, title, default_contractor_id FROM content_items
     WHERE model_id = ${model.id}::uuid AND promo_channel_id = ${row.id}::uuid AND type = 'PRM'
       AND deleted_at IS NULL
     ORDER BY number DESC`)
  const rows = await materialRows(q, model, { channel: row.id })
  const handoffs = await handoffsOf(q, model, { packages: items.map((item) => item.id) })
  const collections = items.map((item) =>
    collectionHead(
      model,
      item,
      row.code,
      rows.filter((material) => material.package_id === item.id),
      handoffs.filter((handoff) => handoff.collection_id === publicIdOf(item.type, item.number)),
    ),
  )
  // Every file once, the newest addition first (DESIGN §4.17).
  const seen = new Set<string>()
  const materials = [...rows]
    .sort((a, b) => b.added_at.localeCompare(a.added_at))
    .filter((material) => {
      if (seen.has(material.asset_id)) return false
      seen.add(material.asset_id)
      return true
    })
  const covers = [...materials].slice(0, MOSAIC).map((material) => thumbOf(model, material))
  return {
    channel: channelOf(row, covers),
    collections,
    materials: await membersOf(q, model, materials),
  }
}

// ---------------------------------------------------------------------------
// Contractors and the check «уже передавали»
// ---------------------------------------------------------------------------

interface ContractorRow extends Record<string, unknown> {
  id: string
  name: string
  channel: string | null
  contact: string | null
  format: ContractorFormat
  row_version: number
}

export function contractorOf(row: ContractorRow): Contractor {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    contact: row.contact,
    format: row.format,
    version: row.row_version,
  }
}

export async function contractorRows(
  q: Queryable,
  model: ModelScope,
  id?: string,
): Promise<ContractorRow[]> {
  if (id !== undefined && !isUuid(id)) return []
  const { rows } = await q.execute<ContractorRow>(sql`
    SELECT c.id, c.name, ch.code AS channel, c.contact, c.format, c.row_version::int AS row_version
      FROM contractors c
      LEFT JOIN promo_channels ch ON ch.model_id = c.model_id AND ch.id = c.channel_id
     WHERE c.model_id = ${model.id}::uuid AND c.archived_at IS NULL
       ${id === undefined ? sql`` : sql`AND c.id = ${id}::uuid`}
     ORDER BY c.created_at, c.id`)
  return rows
}

export async function findContractor(
  q: Queryable,
  model: ModelScope,
  id: string,
): Promise<ContractorRow> {
  const [row] = await contractorRows(q, model, id)
  if (!row) throw new ApiProblem('not_found', 'Такого подрядчика нет', { contractor: id })
  return row
}

/** «38 из 100 уже передавали Coraline Red (PRM-011, 02.09)» for a whole collection. */
export async function overlapOf(
  q: Queryable,
  model: ModelScope,
  collection: string,
  contractorId: string,
): Promise<HandoffOverlap> {
  const item = await findCollection(q, model, collection)
  const contractor = await findContractor(q, model, contractorId)
  const members = await membersOf(q, model, await materialRows(q, model, { packages: [item.id] }))
  return computeHandoffOverlap(members, { id: contractor.id, name: contractor.name }, today())
}

// ---------------------------------------------------------------------------
// From the source object (SPEC §7.1)
// ---------------------------------------------------------------------------

/**
 * Where the files of an object went in «Промо»: the live collections holding them (with the
 * collection's contractor) and the sent handoffs that carried them. Files are named by their
 * handles in the object.
 */
export async function itemPromo(
  q: Queryable,
  model: ModelScope,
  itemId: string,
): Promise<ItemPromo> {
  const { rows: held } = await q.execute<{
    type: string
    number: number
    title: string | null
    channel: string
    channel_name: string
    contractor: string | null
    role: string
    ordinal: number | null
    variant_no: number
  }>(sql`
    SELECT p.type, p.number, p.title, ch.code AS channel, ch.title AS channel_name,
           c.name AS contractor, own.role, own.ordinal, own.variant_no
      FROM item_memberships own
      JOIN item_memberships ref ON ref.model_id = own.model_id AND ref.asset_id = own.asset_id
                               AND ref.item_id <> own.item_id AND ref.removed_at IS NULL
      JOIN content_items p ON p.model_id = ref.model_id AND p.id = ref.item_id
                          AND p.type = 'PRM' AND p.deleted_at IS NULL
      JOIN promo_channels ch ON ch.model_id = p.model_id AND ch.id = p.promo_channel_id
      LEFT JOIN contractors c ON c.model_id = p.model_id AND c.id = p.default_contractor_id
     WHERE own.model_id = ${model.id}::uuid AND own.item_id = ${itemId}::uuid
       AND own.kind = 'owned' AND own.removed_at IS NULL
     ORDER BY p.number, own.display_position NULLS LAST, own.id`)
  const collections = new Map<string, ItemPromo['collections'][number]>()
  for (const row of held) {
    const id = publicIdOf(row.type, row.number)
    const entry = collections.get(id) ?? {
      id,
      title: row.title ?? id,
      channel: row.channel,
      channel_name: row.channel_name,
      contractor: row.contractor,
      files: [],
    }
    entry.files.push(handleOf(row.role, row.ordinal, row.variant_no))
    collections.set(id, entry)
  }
  const { rows: sent } = await q.execute<{
    delivery_id: string
    contractor: string
    type: string
    number: number
    on: string
    role: string
    ordinal: number | null
    variant_no: number
  }>(sql`
    SELECT d.id AS delivery_id, c.name AS contractor, p.type, p.number,
           coalesce((d.sent_at AT TIME ZONE 'Europe/Moscow')::date::text,
                    d.summary ->> 'folder_date',
                    (d.created_at AT TIME ZONE 'Europe/Moscow')::date::text) AS on,
           own.role, own.ordinal, own.variant_no
      FROM item_memberships own
      JOIN asset_manifest_entries e ON e.model_id = own.model_id AND e.asset_id = own.asset_id
      JOIN promo_deliveries d ON d.model_id = e.model_id AND d.manifest_id = e.manifest_id
                             AND d.state = 'sent'
      JOIN contractors c ON c.model_id = d.model_id AND c.id = d.contractor_id
      JOIN content_items p ON p.model_id = d.model_id AND p.id = d.package_item_id
     WHERE own.model_id = ${model.id}::uuid AND own.item_id = ${itemId}::uuid
       AND own.kind = 'owned' AND own.removed_at IS NULL
     ORDER BY 5, d.created_at, d.id, e.position`)
  const handed = new Map<string, ItemPromo['handed'][number]>()
  for (const row of sent) {
    const entry = handed.get(row.delivery_id) ?? {
      contractor: row.contractor,
      collection_id: publicIdOf(row.type, row.number),
      on: row.on,
      files: [],
    }
    const file = handleOf(row.role, row.ordinal, row.variant_no)
    if (!entry.files.includes(file)) entry.files.push(file)
    handed.set(row.delivery_id, entry)
  }
  return { collections: [...collections.values()], handed: [...handed.values()] }
}
