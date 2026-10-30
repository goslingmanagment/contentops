import { createHash } from 'node:crypto'
import type { CatalogEntry, RawPurpose } from '@contentops/contracts/domain/catalog'
import type { ThumbRef } from '@contentops/contracts/domain/common'
import type { ItemType } from '@contentops/contracts/domain/item-type'
import type { Queryable } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import type { ModelScope } from '../context'
import { itemTypeOfDb, publicIdOf } from './ids'

/**
 * The compact catalog index (SPEC §12.0 «Интерфейс»): the view `catalog_index` as entries of
 * the contract. Fields that come with later migrations stay empty: the custom delivery date
 * and the order (`0004_orders`).
 */

/** The shared vendor tag: «SteadyContent» is a tag, not a column (schema §9.2). */
export const STEADY_CONTENT_TAG = 'steadycontent'

interface IndexRow extends Record<string, unknown> {
  item_id: string
  type: string
  number: number
  title: string | null
  title_en: string | null
  tags: string[]
  markup_state: CatalogEntry['markup']
  cover_media: 'video' | 'image' | null
  cover_width: number | null
  cover_height: number | null
  duration_ms: number | null
  photo_count: number | null
  video_count: number | null
  version_count: number | null
  has_teaser: boolean
  size_bytes: number | null
  arrived_on: string
  shot_on: string | null
  ppv_kind: CatalogEntry['ppv_kind']
  raw_purpose: 'fyp' | 'ppv' | 'mass_dm' | 'unknown' | null
  ppv_made_as: string | null
  name_in_media: CatalogEntry['fan_name']
  has_second_person: boolean | null
  selected_count: number | null
  processed_count: number | null
  life_unassigned: number | null
  life_chat_count: number | null
  life_feed_count: number | null
  photo_custom: boolean
  aliases: string[]
  promo_channel_code: string | null
}

/** `mass_dm` of the schema is «рассылка» of the contract. */
export function rawPurposeOf(value: IndexRow['raw_purpose']): RawPurpose | null {
  if (value === null) return null
  return value === 'mass_dm' ? 'mailing' : value
}

export function dbRawPurpose(value: RawPurpose): NonNullable<IndexRow['raw_purpose']> {
  return value === 'mailing' ? 'mass_dm' : value
}

export function thumbRatio(
  media: 'video' | 'image' | null,
  width: number | null,
  height: number | null,
): ThumbRef['ratio'] {
  if (width && height) {
    if (width === height) return '1:1'
    if (width > height) return '16:9'
    return media === 'video' ? '9:16' : '3:4'
  }
  return media === 'image' ? '3:4' : '9:16'
}

/** Counts that are about the type; `null` means «не про этот тип» (contract). */
const PHOTO_TYPES = new Set<ItemType>(['ppv', 'custom', 'set', 'sexting', 'life', 'raw', 'promo'])
const VIDEO_TYPES = new Set<ItemType>(['sexting', 'life', 'raw', 'promo'])

function entryOf(row: IndexRow): CatalogEntry {
  const type = itemTypeOfDb(row.type)
  const id = publicIdOf(row.type, row.number)
  return {
    id,
    type,
    title: row.title ?? '',
    title_en: row.title_en,
    tags: row.tags,
    markup: row.markup_state,
    cover: { key: id, ratio: thumbRatio(row.cover_media, row.cover_width, row.cover_height) },
    duration_s: row.duration_ms ? Math.round(row.duration_ms / 1000) : null,
    photo_count: PHOTO_TYPES.has(type) ? (row.photo_count ?? 0) : null,
    video_count: VIDEO_TYPES.has(type) ? (row.video_count ?? 0) : null,
    version_count: Math.max(1, row.version_count ?? 1),
    has_teaser: row.has_teaser,
    arrived_on: row.arrived_on,
    shot_on: row.shot_on,
    ppv_kind: row.ppv_kind,
    raw_purpose: rawPurposeOf(row.raw_purpose),
    ppv_made_as: (row.ppv_made_as as CatalogEntry['ppv_made_as']) ?? null,
    fan_name: type === 'custom' ? row.name_in_media : null,
    second_person: row.has_second_person === true,
    delivered_on: null,
    selected_count: row.selected_count,
    processed_count: row.processed_count,
    life_unassigned: row.life_unassigned,
    life_chat_count: row.life_chat_count,
    life_feed_count: row.life_feed_count,
    steady_content: row.tags.includes(STEADY_CONTENT_TAG),
    photo_custom: row.photo_custom,
    aliases: row.aliases,
    order_id: null,
    channel: row.promo_channel_code,
    size_bytes: type === 'promo' ? (row.size_bytes ?? 0) : null,
  }
}

/** Entries of live objects of the model, newest first; `where` narrows by `catalog_index` columns. */
export async function catalogEntries(
  q: Queryable,
  model: ModelScope,
  where: SQL = sql``,
  tail: SQL = sql`ORDER BY c.created_at DESC, c.item_id DESC`,
): Promise<(CatalogEntry & { uid: string; created_at: string })[]> {
  const { rows } = await q.execute<IndexRow & { created_at: string }>(sql`
    SELECT c.item_id, c.type, c.number, c.title, c.title_en, c.tags, c.markup_state,
           cover.media_kind AS cover_media, c.cover_width, c.cover_height,
           c.duration_ms::float8 AS duration_ms, c.photo_count, c.video_count,
           c.version_count, c.has_teaser, c.size_bytes::float8 AS size_bytes,
           (c.arrived_at AT TIME ZONE 'Europe/Moscow')::date::text AS arrived_on,
           c.shot_on::text AS shot_on, c.ppv_kind, c.raw_purpose, c.ppv_made_as,
           c.name_in_media, c.has_second_person, c.selected_count, c.processed_count,
           c.life_unassigned, c.life_chat_count, c.life_feed_count, c.photo_custom, c.aliases,
           c.promo_channel_code, c.created_at::text AS created_at
      FROM catalog_index c
      LEFT JOIN LATERAL (
        SELECT a.media_kind FROM asset_versions v JOIN assets a
            ON a.model_id = v.model_id AND a.id = v.asset_id
         WHERE v.model_id = c.model_id AND v.id = c.cover_version_id
      ) cover ON true
     WHERE c.model_id = ${model.id}::uuid ${where}
     ${tail}`)
  return rows.map((row) => ({ ...entryOf(row), uid: row.item_id, created_at: row.created_at }))
}

/** The ETag of a whole resource is the hash of its content (SPEC §12.0). */
export function contentTag(prefix: string, value: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(value)).digest('base64url')
  return `"${prefix}-${digest.slice(0, 22)}"`
}
