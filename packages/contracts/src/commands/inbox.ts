import { z } from 'zod'
import { FileRoleSchema } from '../domain/files'
import { DraftFieldsSchema, VideoInSetDestinationSchema } from '../domain/inbox'
import { ItemIdSchema, ItemTypeSchema } from '../domain/item-type'

export const UpdateDraftCommandSchema = DraftFieldsSchema.partial()
export type UpdateDraftCommand = z.infer<typeof UpdateDraftCommandSchema>

/** Answers to ◆ «нужно решение». */
export const DecideCommandSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('which_order'), order_id: z.string().nullable() }),
  z.object({ decision: z.literal('what_is_it'), type: ItemTypeSchema }),
  z.object({ decision: z.literal('video_in_set'), destination: VideoInSetDestinationSchema }),
  z.object({ decision: z.literal('substitute_montage'), substitute: z.boolean() }),
  z.object({ decision: z.literal('cross_model'), keep: z.boolean() }),
  z.object({ decision: z.literal('number_taken'), keep: z.boolean() }),
  /** `split` — each folder of the archive becomes its own group; otherwise one group. */
  z.object({ decision: z.literal('split_archive'), split: z.boolean() }),
])
export type DecideCommand = z.infer<typeof DecideCommandSchema>

/** «Дополнить…»: in which role the files of the draft join an existing object. */
export const ExtendRoleSchema = z.enum(['photos', 'teaser', 'master_version'])
export type ExtendRole = z.infer<typeof ExtendRoleSchema>

export const EXTEND_ROLE_LABEL: Record<ExtendRole, string> = {
  photos: 'Фото',
  teaser: 'Тизер',
  master_version: 'Новая версия мастера',
}

/** «Принять», «Принять как сдачу», «Принять как исправление», «Принять отдельно». */
export const AcceptCommandSchema = z.object({
  as: z.enum(['default', 'separate']),
  /** «Дополнить…»: the files join this object in this role instead of making a new one. */
  extend: z.object({ item_id: ItemIdSchema, role: ExtendRoleSchema }).nullable().optional(),
})
export type AcceptCommand = z.infer<typeof AcceptCommandSchema>

/** Roles and order of the draft files: the role chip menu and photos moved by drag. */
export const UpdateDraftFilesCommandSchema = z.object({
  roles: z.array(z.object({ key: z.string(), role: FileRoleSchema })).optional(),
  /** Every file key in the new order. */
  order: z.array(z.string()).optional(),
})
export type UpdateDraftFilesCommand = z.infer<typeof UpdateDraftFilesCommandSchema>

export const GroupIdsCommandSchema = z.object({ group_ids: z.array(z.string()).min(1) })
export type GroupIdsCommand = z.infer<typeof GroupIdsCommandSchema>

export const MergeGroupsCommandSchema = z.object({ group_ids: z.array(z.string()).min(2) })
export type MergeGroupsCommand = z.infer<typeof MergeGroupsCommandSchema>

export const SetGroupsTypeCommandSchema = z.object({
  group_ids: z.array(z.string()).min(1),
  type: ItemTypeSchema,
})
export type SetGroupsTypeCommand = z.infer<typeof SetGroupsTypeCommandSchema>

export const SplitGroupCommandSchema = z.object({ file_keys: z.array(z.string()).min(1) })
export type SplitGroupCommand = z.infer<typeof SplitGroupCommandSchema>

export const RejectGroupCommandSchema = z.object({ reason: z.string().trim().nullable() })
export type RejectGroupCommand = z.infer<typeof RejectGroupCommandSchema>
