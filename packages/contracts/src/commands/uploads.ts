import { z } from 'zod'
import { PpvKindSchema } from '../domain/catalog'
import { MediaKindSchema } from '../domain/files'
import { ItemIdSchema, ItemTypeSchema } from '../domain/item-type'

/**
 * Web upload (DESIGN §3.7). The file bytes travel by tus 1.0 (SPEC §6.1) to
 * `/api/v1/<model>/uploads/tus`, chunk by chunk, resumed from the accepted byte; this command
 * is the last step — «the files are here, check them and put them where they belong». With a
 * target the files are accepted by themselves; without one («Другое») they arrive in
 * «Приехало» as a group «Загружено вами».
 */

/** What the files are, one button in the upload window. */
export const UploadKindSchema = z.enum([
  'fyp_montage',
  'teaser',
  'frames',
  'master_version',
  'other',
])
export type UploadKind = z.infer<typeof UploadKindSchema>

export const UPLOAD_KIND_LABEL: Record<UploadKind, string> = {
  fyp_montage: 'Монтаж фупа',
  teaser: 'Тизер',
  frames: 'Обработанные кадры',
  master_version: 'Новая версия мастера',
  other: 'Другое',
}

/** Everything except «Другое» goes to a target and is accepted by itself after the check. */
export function uploadKindNeedsTarget(kind: UploadKind): boolean {
  return kind !== 'other'
}

/**
 * An object, a plan row (the montage for a row waiting for it), or a new PPV made from a
 * custom with one's own montage («Сделать PPV» → «Загрузить свой монтаж», DESIGN §4.5): the
 * montage is accepted on upload as the master of the new PPV (SPEC §6.1).
 */
export const UploadTargetRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), item_id: ItemIdSchema }),
  z.object({ kind: z.literal('plan_row'), row_id: z.string().min(1) }),
  z.object({
    kind: z.literal('ppv_from_custom'),
    item_id: ItemIdSchema,
    ppv_kind: PpvKindSchema,
    title: z.string().trim().min(1, 'Нужно название'),
  }),
])
export type UploadTargetRef = z.infer<typeof UploadTargetRefSchema>

/** The address of a tus upload of a model: `Location` of its creation, the id is its tail. */
export function tusUploadsPath(model: string): string {
  return `/api/v1/${model}/uploads/tus`
}

export const UploadedFileSchema = z.object({
  /** The tus upload that carried the bytes: the last segment of its address. */
  upload_id: z.string().regex(/^[0-9a-f-]{36}$/),
  file_name: z.string().min(1),
  size_bytes: z.int().nonnegative(),
  media: MediaKindSchema,
})
export type UploadedFile = z.infer<typeof UploadedFileSchema>

export const CreateUploadCommandSchema = z
  .object({
    kind: UploadKindSchema,
    target: UploadTargetRefSchema.nullable(),
    /** «Другое» with a known type; without it the group asks ◆ «Что это?». */
    type: ItemTypeSchema.nullable().optional(),
    files: z.array(UploadedFileSchema).min(1),
  })
  .refine((command) => uploadKindNeedsTarget(command.kind) === (command.target !== null), {
    message: 'Цель нужна всем видам, кроме «Другое»',
    path: ['target'],
  })
export type CreateUploadCommand = z.infer<typeof CreateUploadCommandSchema>
