import { z } from 'zod'
import { CatalogEntrySchema } from './catalog'
import {
  AccountCodeSchema,
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  RecordVersionSchema,
  StatusWordSchema,
} from './common'
import { FypVersionSchema, ItemFileSchema, MasterFrameSchema } from './files'
import { AcceptResultSchema } from './inbox'
import { ItemIdSchema } from './item-type'
import { MarkupFieldSchema } from './markup'
import { OperationAcceptedSchema } from './operations'
import { PageSummaryEntrySchema, PlacementVerdictSchema, SurfaceKindSchema } from './placement'
import { ItemPromoSchema } from './promo'
import { ProvenanceLinkSchema } from './provenance'

/** An old name of the object; names with fans are visible only to those who see the order. */
export const OldNameSchema = z.object({
  name: z.string(),
  kind: z.enum(['folder', 'file', 'album', 'number']),
  with_fan_name: z.boolean(),
})
export type OldName = z.infer<typeof OldNameSchema>

export const PlacementActionSchema = z.enum(['Сверить', 'Залить сейчас', 'В план'])
export type PlacementAction = z.infer<typeof PlacementActionSchema>

/** One surface of one page in the panel «Где залито · Fansly 3». */
export const SurfacePlacementSchema = z.object({
  surface: SurfaceKindSchema,
  verdict: PlacementVerdictSchema,
  plan_row_id: z.string().nullable(),
  /** Vault album name by the norm, or an old one as it is on the platform. */
  album: z.string().nullable(),
  caption: z.string().nullable(),
  views: z.int().nonnegative().nullable(),
  stats_on: LocalDateSchema.nullable(),
})
export type SurfacePlacement = z.infer<typeof SurfacePlacementSchema>

export const ItemPagePlacementSchema = z.object({
  account: AccountCodeSchema,
  summary: PageSummaryEntrySchema,
  surfaces: z.array(SurfacePlacementSchema),
  /** The one button of the case: «Сверить», «Залить сейчас» or «В план». */
  action: PlacementActionSchema.nullable(),
})
export type ItemPagePlacement = z.infer<typeof ItemPagePlacementSchema>

/** Download receipt (квитанция выдачи). */
export const DownloadReceiptSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  by: ActorRefSchema,
  at: InstantSchema,
  meta_stripped: z.boolean(),
  plan_row_id: z.string().nullable(),
})
export type DownloadReceipt = z.infer<typeof DownloadReceiptSchema>

export const ItemLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active') }),
  z.object({ state: z.literal('deleted'), at: InstantSchema, by: z.string() }),
  z.object({ state: z.literal('merged'), into: ItemIdSchema, at: InstantSchema }),
])
export type ItemLifecycle = z.infer<typeof ItemLifecycleSchema>

/**
 * Frames checked before the object goes to a fan (DESIGN §4.20, «Посмотреть кадры»):
 * the frames not to send and the verdict for one master version — «проверено для v2».
 */
export const FrameCheckSchema = z.object({
  version: z.int().positive(),
  /** Frames not to send: `t:250` — the master frame at 4:10, or a file key of a photo. */
  blocked: z.array(z.string()),
  /** «Можно отправлять» / «Не отправлять». */
  verdict: z.enum(['send', 'hold']),
  by: z.string(),
  at: InstantSchema,
})
export type FrameCheck = z.infer<typeof FrameCheckSchema>

/** `GET /api/v1/<model>/i/<ID>` — the object as its page shows it. */
export const ItemDetailSchema = z.object({
  entry: CatalogEntrySchema,
  version: RecordVersionSchema,
  lifecycle: ItemLifecycleSchema,
  files: z.array(ItemFileSchema),
  frames: z.array(MasterFrameSchema),
  fyp_versions: z.array(FypVersionSchema),
  markup: z.array(MarkupFieldSchema),
  provenance: z.array(ProvenanceLinkSchema),
  ydisk: z.object({
    path: z.string(),
    url: z.string(),
    old_names: z.array(OldNameSchema),
  }),
  pages: z.array(ItemPagePlacementSchema),
  /** Custom: the order and its state word. */
  order: z.object({ id: z.string(), title: z.string(), status: StatusWordSchema }).nullable(),
  /** Promo collection: handoffs of this collection. */
  handoffs: z.array(z.object({ id: z.string(), status: StatusWordSchema })),
  /** Collections and handoffs that hold the object's files (SPEC §7.1). */
  promo: ItemPromoSchema,
  receipts: z.array(DownloadReceiptSchema),
  /** Custom «готов для PPV»: a video custom without PPV whose order is delivered, no open revision. */
  ready_for_ppv: z.boolean(),
  /** The last frame check; `null` — not checked yet. */
  frame_check: FrameCheckSchema.nullable(),
  /**
   * Custom: its own montage for a PPV is uploading or being checked; the PPV and its number
   * come when the check passes (DESIGN §4.2, §3.7).
   */
  ppv_montage: z.object({ operation_id: z.string() }).nullable(),
})
export type ItemDetail = z.infer<typeof ItemDetailSchema>

/**
 * Answer of «Сделать PPV»: with the master as is — the new number at once; with an own
 * montage — the upload with the target «PPV из CUS-…», accepted by itself after the check.
 * The number is in the result of that operation (SPEC §4: accept only a checked master).
 */
export const MakePpvResultSchema = z.union([AcceptResultSchema, OperationAcceptedSchema])
export type MakePpvResult = z.infer<typeof MakePpvResultSchema>
