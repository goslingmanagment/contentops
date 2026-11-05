import { z } from 'zod'
import { PpvKindSchema, RawPurposeSchema } from '../domain/catalog'
import { LifeAssignmentSchema } from '../domain/files'
import { ItemIdSchema } from '../domain/item-type'
import { UniqLevelSchema } from '../domain/model'

/**
 * Commands on the files of one object (DESIGN §4.5): order, picked set frames, life
 * purposes, photos and cover from master frames, FYP versions, raw footage.
 */

const FileKeysSchema = z.array(z.string().min(1)).min(1)

/** New order of photos, picked set frames or sexting files: «всё или ничего». */
export const ReorderFilesCommandSchema = z.object({ keys: FileKeysSchema })
export type ReorderFilesCommand = z.infer<typeof ReorderFilesCommandSchema>

/** Set: `1` — отобрать кадр, `3` — убрать из отобранных. */
export const PickFramesCommandSchema = z.object({
  keys: FileKeysSchema,
  selected: z.boolean(),
})
export type PickFramesCommand = z.infer<typeof PickFramesCommandSchema>

/** Life: «В ленту», «В чаты», «Оба»; `null` — снять назначение. */
export const AssignLifeCommandSchema = z.object({
  keys: FileKeysSchema,
  assignment: LifeAssignmentSchema.nullable(),
})
export type AssignLifeCommand = z.infer<typeof AssignLifeCommandSchema>

/** «Убрать из объекта…». */
export const RemoveFilesCommandSchema = z.object({ keys: FileKeysSchema })
export type RemoveFilesCommand = z.infer<typeof RemoveFilesCommandSchema>

/** «Скачать» выбранные файлы объекта. */
export const DownloadFilesCommandSchema = z.object({
  keys: FileKeysSchema,
  strip_metadata: z.boolean(),
})
export type DownloadFilesCommand = z.infer<typeof DownloadFilesCommandSchema>

/** «Сделать фото»: frames of the master in full size, a long operation. */
export const MakePhotosCommandSchema = z.object({
  frames: z.array(z.number().nonnegative()).min(1),
})
export type MakePhotosCommand = z.infer<typeof MakePhotosCommandSchema>

/** «Сделать обложкой»: a master frame or a photo of the object. */
export const MakeCoverCommandSchema = z.discriminatedUnion('from', [
  z.object({ from: z.literal('frame'), t_s: z.number().nonnegative() }),
  z.object({ from: z.literal('file'), key: z.string().min(1) }),
])
export type MakeCoverCommand = z.infer<typeof MakeCoverCommandSchema>

/** «Собрать версии» of a FYP: how many and how strongly they differ. */
export const BuildFypVersionsCommandSchema = z.object({
  count: z.int().min(1).max(5),
  level: UniqLevelSchema,
})
export type BuildFypVersionsCommand = z.infer<typeof BuildFypVersionsCommandSchema>

/** Raw footage: «Назначение: фупы / PPV / рассылка / неизвестно». */
export const SetRawPurposeCommandSchema = z.object({ purpose: RawPurposeSchema })
export type SetRawPurposeCommand = z.infer<typeof SetRawPurposeCommandSchema>

/**
 * «Выделить в новый объект» («в новую съёмку» у сырья): the files leave this object for a new
 * one of the same type.
 */
export const ExtractShootCommandSchema = z.object({ keys: FileKeysSchema })
export type ExtractShootCommand = z.infer<typeof ExtractShootCommandSchema>

/**
 * «Слить с…»: two objects of one type become one; the lower number stays, the other one is its
 * old name (SPEC §4.1).
 */
export const MergeItemsCommandSchema = z.object({ into: ItemIdSchema })
export type MergeItemsCommand = z.infer<typeof MergeItemsCommandSchema>

/** «Перенести в…»: the files go to another object of the model, of any type. */
export const MoveFilesCommandSchema = z.object({ keys: FileKeysSchema, into: ItemIdSchema })
export type MoveFilesCommand = z.infer<typeof MoveFilesCommandSchema>

/** A file of the catalog by its object and handle: `LIFE-005/pic34`, `FYP-0036/master`. */
export const FileAddressSchema = z
  .string()
  .regex(/^(PPV|FYP|CUS|SET|SXT|LIFE|RAW|PRM)-\d{3,6}\/[a-z]+\d*$/, 'Адрес файла: LIFE-005/pic34')
export type FileAddress = z.infer<typeof FileAddressSchema>

/**
 * «Это копия <файл>»: a file of this object repeats a file elsewhere in the catalog (a
 * compressed preview, a second export). It leaves its object, its names find the original, its
 * draft becomes a duplicate alias of the original (SPEC §6.2).
 */
export const CopyOfCommandSchema = z.object({
  files: z.array(z.object({ key: z.string().min(1), original: FileAddressSchema })).min(1),
})
export type CopyOfCommand = z.infer<typeof CopyOfCommandSchema>

/** «Не контент»: accepted files leave the object, their drafts are refused with the reason. */
export const NotContentCommandSchema = z.object({
  keys: FileKeysSchema,
  reason: z.string().trim().min(1, 'Нужна причина'),
})
export type NotContentCommand = z.infer<typeof NotContentCommandSchema>

/**
 * «Новая версия мастера из файла»: the bytes of a file already in the catalog — in an object or
 * left it (`FYP-0036/master` of a merged FYP) — become the next version of this object's master.
 */
export const MasterVersionCommandSchema = z.object({ from: FileAddressSchema })
export type MasterVersionCommand = z.infer<typeof MasterVersionCommandSchema>

/** «Сделать мастером PPV»: a video of raw footage becomes the master of a new PPV. */
export const MakeMasterCommandSchema = z.object({
  file_key: z.string().min(1),
  kind: PpvKindSchema,
  title: z.string().trim().min(1, 'Нужно название'),
})
export type MakeMasterCommand = z.infer<typeof MakeMasterCommandSchema>
