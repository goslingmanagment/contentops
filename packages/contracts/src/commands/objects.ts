import { z } from 'zod'
import { FanNameSchema, PpvKindSchema } from '../domain/catalog'
import { AccountCodeSchema, RecordVersionSchema } from '../domain/common'
import { ItemIdSchema, ItemTypeSchema } from '../domain/item-type'
import { MarkupFieldKeySchema } from '../domain/markup'
import { SurfaceKindSchema } from '../domain/placement'

/** «Подтвердить всю разметку»: exactly the field versions the person saw. */
export const ConfirmMarkupCommandSchema = z.object({
  fields: z.array(z.object({ key: MarkupFieldKeySchema, version: RecordVersionSchema })).min(1),
})
export type ConfirmMarkupCommand = z.infer<typeof ConfirmMarkupCommandSchema>

export const SetItemFlagsCommandSchema = z.object({
  second_person: z.boolean().optional(),
  fan_name: FanNameSchema.optional(),
  /** Required when OnlyFans rows exist: «Снимет 2 строки на OnlyFans · Снять и отметить». */
  cancel_onlyfans_rows: z.boolean().optional(),
})
export type SetItemFlagsCommand = z.infer<typeof SetItemFlagsCommandSchema>

/** `PUT …/i/<ID>/frame-check` — the frame sheet of «Разметка на проверку» (DESIGN §4.20). */
export const SaveFrameCheckCommandSchema = z.object({
  /** The master version the frames were looked at for. */
  version: z.int().positive(),
  blocked: z.array(z.string()),
  verdict: z.enum(['send', 'hold']),
})
export type SaveFrameCheckCommand = z.infer<typeof SaveFrameCheckCommandSchema>

export const DownloadKindSchema = z.enum([
  'platform',
  'master',
  'compat',
  'photos',
  'fan',
  'source',
  'teaser',
])
export type DownloadKind = z.infer<typeof DownloadKindSchema>

export const DOWNLOAD_KIND_LABEL: Record<DownloadKind, string> = {
  platform: 'Для заливки',
  master: 'Мастер (для монтажа)',
  compat: 'Копия, которая откроется везде',
  photos: 'Фото 100 %',
  fan: 'Для фана',
  source: 'Исходник',
  teaser: 'Тизер',
}

export const DownloadCommandSchema = z.object({
  kind: DownloadKindSchema,
  strip_metadata: z.boolean(),
  /** Page code in the file name, for «Залить сейчас» and plan rows. */
  account: AccountCodeSchema.nullable(),
  /** Plan row: its day and time go into the name (§2.5), the receipt is tied to it. */
  plan_row: z.string().nullable().optional(),
})
export type DownloadCommand = z.infer<typeof DownloadCommandSchema>

/** «Залить сейчас»: a plan row for today and a download named for the page. */
export const UploadNowCommandSchema = z.object({
  account: AccountCodeSchema,
  surface: SurfaceKindSchema,
})
export type UploadNowCommand = z.infer<typeof UploadNowCommandSchema>

export const ChangeTypeCommandSchema = z.object({ type: ItemTypeSchema })
export type ChangeTypeCommand = z.infer<typeof ChangeTypeCommandSchema>

/** The own montage of «Загрузить свой монтаж»: it becomes the master once checked. */
export const MontageFileSchema = z.object({
  file_name: z.string().min(1),
  size_bytes: z.int().positive(),
})
export type MontageFile = z.infer<typeof MontageFileSchema>

/**
 * «Сделать PPV» from a custom (DESIGN §4.5): the master as is, or an own montage. The
 * montage file is required for `upload` and absent for `as_is`.
 */
export const MakePpvCommandSchema = z
  .object({
    kind: PpvKindSchema,
    title: z.string().trim().min(1, 'Нужно название'),
    source: z.enum(['as_is', 'upload']),
    montage: MontageFileSchema.nullable(),
  })
  .refine((command) => command.source !== 'upload' || command.montage !== null, {
    path: ['montage'],
    message: 'Выберите файл монтажа',
  })
  .refine((command) => command.source !== 'as_is' || command.montage === null, {
    path: ['montage'],
    message: 'Мастер берётся как есть — файл не нужен',
  })
export type MakePpvCommand = z.infer<typeof MakePpvCommandSchema>

/** «Уже залито» for selected objects on one page (DESIGN §4.3). */
export const AlreadyUploadedCommandSchema = z.object({
  account: AccountCodeSchema,
  items: z.array(ItemIdSchema).min(1),
})
export type AlreadyUploadedCommand = z.infer<typeof AlreadyUploadedCommandSchema>

export const DeleteItemCommandSchema = z.object({ confirm: z.literal(true) })
export type DeleteItemCommand = z.infer<typeof DeleteItemCommandSchema>
