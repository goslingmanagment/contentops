import { z } from 'zod'
import { ItemIdSchema, ItemTypeSchema } from './item-type'

/** Kinds of origin links between objects (SPEC §4, `provenance_relation`). */
export const ProvenanceRelationSchema = z.enum([
  'made_from',
  'ppv_from_custom',
  'remontage',
  'extracted_from',
  'merged_from',
  'frame_from',
])
export type ProvenanceRelation = z.infer<typeof ProvenanceRelationSchema>

/**
 * Words of a link seen from one side. `out` reads from the object to its source
 * («Сделано из → RAW-0034»), `in` from the source to what was made of it («Из него → …»).
 */
export const PROVENANCE_LABEL: Record<ProvenanceRelation, { out: string; in: string }> = {
  made_from: { out: 'Сделано из', in: 'Из него' },
  ppv_from_custom: { out: 'PPV из кастома', in: 'PPV сделан из него' },
  remontage: { out: 'Перемонтаж из', in: 'Перемонтаж' },
  extracted_from: { out: 'Выделен из', in: 'Выделено из него' },
  merged_from: { out: 'Слит из', in: 'Слит в' },
  frame_from: { out: 'Кадр из', in: 'Кадры из него' },
}

export const ProvenanceLinkSchema = z.object({
  id: z.string(),
  relation: ProvenanceRelationSchema,
  direction: z.enum(['out', 'in']),
  item_id: ItemIdSchema,
  item_type: ItemTypeSchema,
  item_title: z.string(),
  /** Extra words after the title: «Reddit» for a promo collection. */
  extra: z.string().nullable(),
  /** An unconfirmed link is ◆ with «Подтвердить / Убрать». */
  confirmed: z.boolean(),
})
export type ProvenanceLink = z.infer<typeof ProvenanceLinkSchema>

export const NewProvenanceLinkSchema = z.object({
  relation: ProvenanceRelationSchema,
  direction: z.enum(['out', 'in']),
  item_id: ItemIdSchema,
})
export type NewProvenanceLink = z.infer<typeof NewProvenanceLinkSchema>
