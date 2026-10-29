import { z } from 'zod'
import { ItemIdSchema } from '../domain/item-type'
import { SurfaceKindSchema } from '../domain/placement'

/** Answer to «Стена или фуп?» (DESIGN §4.15): where a post went when no marked row says it. */
export const PostSurfaceSchema = SurfaceKindSchema.extract(['wall', 'fyp'])
export type PostSurface = z.infer<typeof PostSurfaceSchema>

/**
 * «Это оно» for one pair; `evidence_id` picks a variant when there are several.
 * `surface` answers «Стена или фуп?» and is accepted only by such a case.
 */
export const ConfirmPairCommandSchema = z.object({
  evidence_id: z.string().nullable(),
  surface: PostSurfaceSchema.optional(),
})
export type ConfirmPairCommand = z.infer<typeof ConfirmPairCommandSchema>

/** «Не то»; without `evidence_id` all open variants are rejected («Ни один»). */
export const RejectPairCommandSchema = z.object({ evidence_id: z.string().nullable() })
export type RejectPairCommand = z.infer<typeof RejectPairCommandSchema>

/** «Привязать…» a post without plan to an object. */
export const BindPostCommandSchema = z.object({ item_id: ItemIdSchema })
export type BindPostCommand = z.infer<typeof BindPostCommandSchema>

/** «Подтвердить однозначные · N»: pairs the person saw in the list. */
export const ConfirmCasesCommandSchema = z.object({ case_ids: z.array(z.string()).min(1) })
export type ConfirmCasesCommand = z.infer<typeof ConfirmCasesCommandSchema>
