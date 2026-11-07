import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Queryable } from '@contentops/db'
import type { MarkupType } from '@contentops/vision'
import { sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { BlobStore } from '../media/storage'

/**
 * What the markup knows of one object before anything is sent (SPEC §8.3): its type, the media
 * its input comes from, the stored frames (512 px, from the decoding pass of intake, SPEC §9.3),
 * the manager's notes and the names that must never leave. Nothing here goes out as it is: the
 * serializer (`serialize.ts`) picks the allowed parts.
 */

export interface SubjectFrame {
  artifactId: string
  storageKey: string
  /** Moment in the video; `null` for a photo. */
  frameMs: number | null
}

export interface AnnotationSubject {
  modelId: string
  itemId: string
  /** `PPV-073`: for the receipts and the journal, never for a provider. */
  publicId: string
  type: MarkupType
  /** The master version of a video object; `null` when the frames are photos. */
  versionId: string | null
  /** A video with its master: the chronology belongs to it. */
  hasVideo: boolean
  durationMs: number | null
  /** The media bytes the input comes from: the master, or the digest of the photos' masters. */
  inputSha256: Buffer
  frames: SubjectFrame[]
  /** The description when a person confirmed it: the manager's notes (SPEC §8.3). */
  notes: string | null
  /** Slugs of the shared tag dictionary. */
  vocabulary: string[]
  /** The object's tags that are words of the shared dictionary. */
  dictionaryTags: string[]
  /** What must never reach a provider, for the cleaning of free text (`serialize.ts`). */
  privacy: Privacy
}

export interface Privacy {
  /**
   * The model's code and names, its pages' codes, names, handles and Hub refs (SPEC §8.3 «имя
   * модели, идентификаторы аккаунтов»).
   */
  names: string[]
  /** The brief and the message excerpts of the orders the object was delivered for. */
  orders: string[]
}

const MARKUP = new Set<string>(['PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW'])

interface ItemRow extends Record<string, unknown> {
  id: string
  type: string
  number: number
  description: string | null
  description_confirmed: boolean
  deleted_at: string | null
}

interface FileRow extends Record<string, unknown> {
  role: string
  media_kind: 'video' | 'image'
  variant_no: number
  version_id: string
  master_sha256: Buffer
  duration_ms: number | null
}

interface FrameRow extends Record<string, unknown> {
  version_id: string
  artifact_id: string
  storage_key: string
  frame_ms: number | null
}

const PAD: Record<string, number> = { FYP: 4, RAW: 4 }

/** Evenly spread picks: the first, the last and equal steps between them. */
export function pickEvenly<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items]
  if (count <= 1) return items.slice(0, Math.max(0, count))
  const step = (items.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)] as T)
}

/**
 * The object and all its stored frames (the stage picks how many go out); `null` when it is
 * gone, merged or has no content to mark up.
 */
export async function loadSubject(
  q: Queryable,
  modelId: string,
  itemId: string,
): Promise<AnnotationSubject | null> {
  const { rows: items } = await q.execute<ItemRow>(sql`
    SELECT i.id, i.type, i.number, i.description, i.deleted_at,
           coalesce((SELECT f.confirmed_value_version = f.value_version FROM annotation_fields f
                      WHERE f.model_id = i.model_id AND f.item_id = i.id
                        AND f.field = 'description'), false) AS description_confirmed
      FROM content_items i
     WHERE i.model_id = ${modelId}::uuid AND i.id = ${itemId}::uuid`)
  const item = items[0]
  if (!item || item.deleted_at || !MARKUP.has(item.type)) return null
  const { rows: files } = await q.execute<FileRow>(sql`
    SELECT im.role, a.media_kind, im.variant_no, v.id AS version_id, v.master_sha256,
           v.duration_ms::float8 AS duration_ms
      FROM item_memberships im
      JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
      JOIN asset_versions v ON v.model_id = a.model_id AND v.id = a.current_version_id
     WHERE im.model_id = ${modelId}::uuid AND im.item_id = ${itemId}::uuid
       AND im.kind = 'owned' AND im.removed_at IS NULL
     ORDER BY im.display_position NULLS LAST, im.id`)
  const master = files.find(
    (file) => file.role === 'master' && file.variant_no === 0 && file.media_kind === 'video',
  )
  const own = master ? [master] : files.filter((file) => file.variant_no === 0)
  if (own.length === 0) return null
  const versionIds = own.map((file) => file.version_id)
  const { rows: frameRows } = await q.execute<FrameRow>(sql`
    SELECT v.id AS version_id, ra.id AS artifact_id, ra.storage_key,
           ra.frame_ms::float8 AS frame_ms
      FROM asset_versions v
      JOIN rendition_generations g ON g.master_sha256 = v.master_sha256 AND g.kind = 'frames'
                                  AND g.is_active AND g.state = 'ready' AND NOT g.meta_stripped
      JOIN rendition_artifacts ra ON ra.generation_id = g.id AND ra.state = 'ready'
     WHERE v.model_id = ${modelId}::uuid AND v.id = ANY(${sql.param(versionIds)}::uuid[])
     ORDER BY ra.frame_ms NULLS FIRST, ra.name`)
  let frames: SubjectFrame[]
  if (master) {
    frames = frameRows.map((row) => ({
      artifactId: row.artifact_id,
      storageKey: row.storage_key,
      frameMs: row.frame_ms,
    }))
  } else {
    // One frame per file in the order of the object: a photo's own, a clip's first.
    const firstOf = new Map<string, FrameRow>()
    for (const row of frameRows) if (!firstOf.has(row.version_id)) firstOf.set(row.version_id, row)
    frames = versionIds.flatMap((id) => {
      const row = firstOf.get(id)
      return row
        ? [{ artifactId: row.artifact_id, storageKey: row.storage_key, frameMs: null }]
        : []
    })
  }
  const inputSha256 = master
    ? master.master_sha256
    : createHash('sha256')
        .update(Buffer.concat(own.map((file) => file.master_sha256).sort(Buffer.compare)))
        .digest()
  const [vocabulary, tags, names, orders] = await Promise.all([
    q.execute<{ slug: string }>(sql`
      SELECT slug FROM tags WHERE model_id IS NULL AND merged_into_tag_id IS NULL ORDER BY slug`),
    q.execute<{ slug: string }>(sql`
      SELECT DISTINCT coalesce(m.slug, t.slug) AS slug FROM item_tags it
        JOIN tags t ON t.id = it.tag_id LEFT JOIN tags m ON m.id = t.merged_into_tag_id
       WHERE it.model_id = ${modelId}::uuid AND it.item_id = ${itemId}::uuid
         AND coalesce(m.model_id, t.model_id) IS NULL
       ORDER BY 1`),
    q.execute<{ name: string | null }>(sql`
      SELECT unnest(ARRAY[m.code, m.title, m.title_genitive]) AS name FROM models m
       WHERE m.id = ${modelId}::uuid
      UNION
      SELECT unnest(ARRAY[a.code, a.title, a.handle, a.hub_page_ref]) FROM accounts a
       WHERE a.model_id = ${modelId}::uuid`),
    q.execute<{ text: string }>(sql`
      WITH own AS (
        SELECT DISTINCT d.order_id FROM custom_order_deliveries d
         WHERE d.model_id = ${modelId}::uuid AND d.item_id = ${itemId}::uuid
      )
      SELECT o.brief AS text FROM custom_orders o JOIN own ON own.order_id = o.id
       WHERE o.model_id = ${modelId}::uuid
      UNION
      SELECT m.excerpt FROM custom_order_messages m JOIN own ON own.order_id = m.order_id
       WHERE m.model_id = ${modelId}::uuid`),
  ])
  return {
    modelId,
    itemId,
    publicId: `${item.type}-${String(item.number).padStart(PAD[item.type] ?? 3, '0')}`,
    type: item.type as MarkupType,
    versionId: master?.version_id ?? null,
    hasVideo: Boolean(master),
    durationMs: master?.duration_ms ?? null,
    inputSha256,
    frames,
    notes: item.description_confirmed && item.description?.trim() ? item.description : null,
    vocabulary: vocabulary.rows.map((row) => row.slug),
    dictionaryTags: tags.rows.map((row) => row.slug),
    privacy: {
      names: names.rows
        .map((row) => row.name?.trim() ?? '')
        .filter((name): name is string => name.length >= 2),
      orders: orders.rows.map((row) => row.text).filter((text) => text.trim().length > 0),
    },
  }
}

/** Long side of the frames that go out (SPEC §8.3). */
export const FRAME_SIDE = 512

/**
 * The bytes of a stored frame as they go out: decoded and encoded again, so no EXIF, XMP or ICC
 * of any origin survives and the long side is at most 512 px. `null` — the file is not there or
 * is not a picture: the frame is withheld, never sent as it is.
 */
export async function frameBytes(store: BlobStore, storageKey: string): Promise<Buffer | null> {
  try {
    const stored = await readFile(store.path(storageKey))
    return await sharp(stored)
      .resize({ width: FRAME_SIDE, height: FRAME_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
  } catch {
    return null
  }
}
