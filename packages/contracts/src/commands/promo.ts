import { z } from 'zod'
import { ItemIdSchema } from '../domain/item-type'

export const MemberRefSchema = z.object({ item_id: ItemIdSchema, file_key: z.string() })
export type MemberRef = z.infer<typeof MemberRefSchema>

/** «В промо ▾ → канал → подборка»: links, never copies; a repeat does not duplicate. */
export const AddToPromoCommandSchema = z.object({
  channel: z.string(),
  collection: z.union([ItemIdSchema, z.literal('new')]),
  title: z.string().trim().nullable(),
  members: z.array(MemberRefSchema).min(1),
})
export type AddToPromoCommand = z.infer<typeof AddToPromoCommandSchema>

export const RemoveFromCollectionCommandSchema = z.object({
  members: z.array(MemberRefSchema).min(1),
})
export type RemoveFromCollectionCommand = z.infer<typeof RemoveFromCollectionCommandSchema>

/** Step one of «Подготовить передачу». */
export const PrepareHandoffCommandSchema = z.object({
  contractor_id: z.string(),
  strip_metadata: z.boolean(),
  /** «Убрать их»: drop what this contractor already got. */
  exclude_already_handed: z.boolean(),
  /** `null` — the whole collection; otherwise only the materials selected in it. */
  members: z.array(MemberRefSchema).min(1).nullable(),
})
export type PrepareHandoffCommand = z.infer<typeof PrepareHandoffCommandSchema>
