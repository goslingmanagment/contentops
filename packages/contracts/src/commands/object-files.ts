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

/** «Выделить в новую съёмку»: the files leave this raw object for a new one. */
export const ExtractShootCommandSchema = z.object({ keys: FileKeysSchema })
export type ExtractShootCommand = z.infer<typeof ExtractShootCommandSchema>

/** «Слить с…»: this raw object joins another one and keeps its ID as an old name. */
export const MergeRawCommandSchema = z.object({ into: ItemIdSchema })
export type MergeRawCommand = z.infer<typeof MergeRawCommandSchema>

/** «Сделать мастером PPV»: a video of raw footage becomes the master of a new PPV. */
export const MakeMasterCommandSchema = z.object({
  file_key: z.string().min(1),
  kind: PpvKindSchema,
  title: z.string().trim().min(1, 'Нужно название'),
})
export type MakeMasterCommand = z.infer<typeof MakeMasterCommandSchema>
