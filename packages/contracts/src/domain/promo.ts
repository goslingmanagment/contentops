import { z } from 'zod'
import {
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  ProgressSchema,
  RecordVersionSchema,
  StatusWordSchema,
  ThumbRefSchema,
} from './common'
import { ItemIdSchema } from './item-type'

/**
 * The one format field of a contractor (SPEC §7.1, решение владельца 30.10.2026): «для
 * заливки» — the platform copy and picked frames, «мастер», «совместимая для монтажа» (H.264).
 */
export const ContractorFormatSchema = z.enum(['upload', 'master', 'compat'])
export type ContractorFormat = z.infer<typeof ContractorFormatSchema>

export const CONTRACTOR_FORMAT_LABEL: Record<ContractorFormat, string> = {
  upload: 'для заливки',
  master: 'мастер',
  compat: 'совместимая для монтажа',
}

/** A recipient without sign-in, in the context of one model. */
export const ContractorSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Code of the channel the contractor usually works with; `null` — any. */
  channel: z.string().nullable(),
  contact: z.string().nullable(),
  format: ContractorFormatSchema,
  /** The format changes with `If-Match` (Настройки › Модели и страницы). */
  version: RecordVersionSchema,
})
export type Contractor = z.infer<typeof ContractorSchema>

export const PromoChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  orientation: z.enum(['vertical', 'landscape']),
  collection_count: z.int().nonnegative(),
  file_count: z.int().nonnegative(),
  last_handoff_on: LocalDateSchema.nullable(),
  covers: z.array(ThumbRefSchema),
})
export type PromoChannel = z.infer<typeof PromoChannelSchema>

/** A material of a collection: a link to a file of another object, never a copy. */
export const CollectionMemberSchema = z.object({
  item_id: ItemIdSchema,
  file_key: z.string(),
  media: z.enum(['video', 'photo']),
  thumb: ThumbRefSchema,
  size_bytes: z.int().nonnegative(),
  /** «▶ 0:15» on the tile; `null` for a photo. */
  duration_s: z.number().nonnegative().nullable(),
  uploaded_on: LocalDateSchema,
  added_on: LocalDateSchema,
  /** Sent handoffs that carried the material, oldest first: «GaranTTeam 18.09 (PRM-015)». */
  handed_to: z.array(
    z.object({
      contractor_id: z.string(),
      contractor: z.string(),
      collection_id: ItemIdSchema,
      on: LocalDateSchema,
    }),
  ),
  /**
   * Prepared handoffs that carry the material but are not marked «Передано» yet: «уже в
   * PRM-013 (подготовлена 21.09, «Передано» не нажато)» (DESIGN §4.17).
   */
  prepared_for: z.array(
    z.object({
      contractor_id: z.string(),
      contractor: z.string(),
      collection_id: ItemIdSchema,
      on: LocalDateSchema,
    }),
  ),
  other_collections: z.array(z.string()),
})
export type CollectionMember = z.infer<typeof CollectionMemberSchema>

/** States of a handoff (DESIGN §5.7). */
export const HandoffStateSchema = z.enum(['preparing', 'prepared', 'sent', 'failed'])
export type HandoffState = z.infer<typeof HandoffStateSchema>

export const HandoffSchema = z.object({
  id: z.string(),
  collection_id: ItemIdSchema,
  contractor_id: z.string(),
  contractor_name: z.string(),
  /** The format the handoff was prepared in; `null` for a past pack recorded by import. */
  format: ContractorFormatSchema.nullable(),
  state: HandoffStateSchema,
  progress: ProgressSchema.nullable(),
  video_count: z.int().nonnegative(),
  photo_count: z.int().nonnegative(),
  size_bytes: z.int().nonnegative(),
  strip_metadata: z.boolean(),
  created_at: InstantSchema,
  sent_on: LocalDateSchema.nullable(),
  failure: z.string().nullable(),
  summary_text: z.string(),
  zip_name: z.string().nullable(),
  /** Where «Скачать ZIP» takes the archive from, once it is prepared. */
  zip_url: z.string().nullable(),
  /** What the handoff carries: `RAW-0213/raw03`; «уже передавали» is counted from it. */
  member_keys: z.array(z.string()),
  /**
   * Names inside the ZIP by naming §6, in order, `manifest.csv` last:
   * `PRM-013_001_RAW-0213-raw03.mp4`. Empty until the handoff is prepared.
   */
  zip_files: z.array(z.string()),
  operation_id: z.string().nullable(),
  recorded_by: ActorRefSchema,
  status: StatusWordSchema,
})
export type Handoff = z.infer<typeof HandoffSchema>

export const PromoCollectionSchema = z.object({
  id: ItemIdSchema,
  title: z.string(),
  channel: z.string(),
  video_count: z.int().nonnegative(),
  photo_count: z.int().nonnegative(),
  size_bytes: z.int().nonnegative(),
  contractor_id: z.string().nullable(),
  members: z.array(CollectionMemberSchema),
  handoffs: z.array(HandoffSchema),
  /** First materials for the folder mosaic of the collection (DESIGN §4.17). */
  covers: z.array(ThumbRefSchema),
  /** Last handoff state for the tile: «✓ передано GaranTTeam 18.09». */
  status: StatusWordSchema.nullable(),
})
export type PromoCollection = z.infer<typeof PromoCollectionSchema>

/**
 * «38 из 100 уже передавали Coraline Red (PRM-011, 02.09)» and, apart from it, «20 из 100
 * уже в PRM-013 (подготовлена 21.09, «Передано» не нажато)» (DESIGN §4.17).
 */
export const HandoffOverlapSchema = z.object({
  contractor_id: z.string(),
  already: z.int().nonnegative(),
  total: z.int().nonnegative(),
  from: z.array(z.object({ collection_id: ItemIdSchema, on: LocalDateSchema })),
  text: z.string().nullable(),
  /** In a prepared handoff to this contractor that nobody marked «Передано». */
  pending: z.int().nonnegative(),
  pending_from: z.array(z.object({ collection_id: ItemIdSchema, on: LocalDateSchema })),
  pending_text: z.string().nullable(),
})
export type HandoffOverlap = z.infer<typeof HandoffOverlapSchema>

/** `GET /api/v1/<model>/promo/channels/<id>` */
export const ChannelContentsSchema = z.object({
  channel: PromoChannelSchema,
  collections: z.array(PromoCollectionSchema.omit({ members: true })),
  /**
   * Every material of the channel's collections, once per file, newest added first (DESIGN
   * §4.17 «ниже — все материалы канала по дням добавления»): a selection here becomes a new
   * collection or joins an existing one.
   */
  materials: z.array(CollectionMemberSchema),
})
export type ChannelContents = z.infer<typeof ChannelContentsSchema>

/**
 * Where the files of an object went in «Промо» (SPEC §7.1: «эти связи доступны и из
 * исходного объекта»): «в промо: PRM-015 · Instagram · GaranTTeam Social», «передавали:
 * GaranTTeam Social 18.09 (PRM-015)». `files` are the object's own handles.
 */
export const ItemPromoSchema = z.object({
  collections: z.array(
    z.object({
      id: ItemIdSchema,
      title: z.string(),
      /** Channel code, for the address of the collection. */
      channel: z.string(),
      channel_name: z.string(),
      /** The collection's contractor; `null` — not chosen yet. */
      contractor: z.string().nullable(),
      files: z.array(z.string()),
    }),
  ),
  /** Sent handoffs (imported past packs too) that carried the object's files, oldest first. */
  handed: z.array(
    z.object({
      contractor: z.string(),
      collection_id: ItemIdSchema,
      on: LocalDateSchema,
      files: z.array(z.string()),
    }),
  ),
})
export type ItemPromo = z.infer<typeof ItemPromoSchema>
