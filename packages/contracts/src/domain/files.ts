import { z } from 'zod'
import {
  AccountCodeSchema,
  InstantSchema,
  LocalDateSchema,
  ProgressSchema,
  ThumbRefSchema,
} from './common'
import { ItemIdSchema } from './item-type'
import { UniqLevelSchema } from './model'

/** Role of a file inside an object. */
export const FileRoleSchema = z.enum([
  'master',
  'teaser',
  'photo',
  'clip',
  'montage',
  'source',
  'raw',
  'promo_link',
])
export type FileRole = z.infer<typeof FileRoleSchema>

export const FILE_ROLE_LABEL: Record<FileRole, string> = {
  master: 'мастер',
  teaser: 'тизер',
  photo: 'фото',
  clip: 'видео',
  montage: 'монтаж',
  source: 'исходник',
  raw: 'файл съёмки',
  promo_link: 'материал',
}

export const MediaKindSchema = z.enum(['video', 'photo'])
export type MediaKind = z.infer<typeof MediaKindSchema>

export const LifeAssignmentSchema = z.enum(['feed', 'chats', 'both'])
export type LifeAssignment = z.infer<typeof LifeAssignmentSchema>

export const LIFE_ASSIGNMENT_LABEL: Record<LifeAssignment, string> = {
  feed: 'лента',
  chats: 'чаты',
  both: 'оба',
}

/** A master rebuilt after a remontage or a fix is a new version; the old one stays. */
export const FileVersionSchema = z.object({
  no: z.int().positive(),
  on: LocalDateSchema,
  /** «перемонтаж», «до правки 20.09». */
  reason: z.string().nullable(),
  duration_s: z.number().nonnegative().nullable(),
})
export type FileVersion = z.infer<typeof FileVersionSchema>

/** Processing of a file: ready, or a word and a share («сжимается 62 %», «проверяется»). */
export const FileStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({
    kind: z.literal('processing'),
    label: z.string(),
    progress: ProgressSchema.nullable(),
  }),
])
export type FileState = z.infer<typeof FileStateSchema>

export const ItemFileSchema = z.object({
  /** Address inside the object: `/lora/a/SET-069/ed07`. */
  key: z.string().min(1),
  role: FileRoleSchema,
  /** Chip on the tile: «мастер», «тизер», «фото 3». */
  label: z.string(),
  media: MediaKindSchema,
  position: z.int().positive().nullable(),
  file_name: z.string(),
  duration_s: z.number().nonnegative().nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
  size_bytes: z.int().nonnegative(),
  thumb: ThumbRefSchema,
  current_version: z.int().positive(),
  versions: z.array(FileVersionSchema),
  state: FileStateSchema,
  /** Set frames: picked for posting, processed copy on top. */
  selected: z.boolean().nullable(),
  processed: z.boolean().nullable(),
  /** Life frames: лента / чаты / оба; `null` — без назначения. */
  assignment: LifeAssignmentSchema.nullable(),
  /** Sexting: «extra», «optional». */
  flags: z.array(z.enum(['extra', 'optional'])),
  shot_at: InstantSchema.nullable(),
  /** Promo material or FYP source: the object and file it points to. */
  source: z.object({ item_id: ItemIdSchema, file_key: z.string() }).nullable(),
})
export type ItemFile = z.infer<typeof ItemFileSchema>

/** «Кадры мастера»: up to ten frames at equal steps, with a timecode. */
export const MasterFrameSchema = z.object({
  t_s: z.number().nonnegative(),
  thumb: ThumbRefSchema,
})
export type MasterFrame = z.infer<typeof MasterFrameSchema>

/** A unique FYP version for a page: «версия 2 · подрезка». */
export const FypVersionSchema = z.object({
  no: z.int().positive(),
  level: UniqLevelSchema,
  thumb: ThumbRefSchema,
  duration_s: z.number().nonnegative(),
  placed: z.array(z.object({ account: AccountCodeSchema, on: LocalDateSchema.nullable() })),
})
export type FypVersion = z.infer<typeof FypVersionSchema>
