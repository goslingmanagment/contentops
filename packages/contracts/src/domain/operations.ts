import { z } from 'zod'
import { InstantSchema, ProgressSchema } from './common'
import { ApiErrorBodySchema } from './errors'
import { ItemIdSchema } from './item-type'

/** Long operations answered with 202 (DESIGN §3.13, п. 7). */
export const OperationKindSchema = z.enum([
  'platform_copy',
  'zip_day',
  'zip_release',
  'zip_week',
  'handoff',
  'fyp_versions',
  'make_photo',
  'make_cover',
  'compat_copy',
  'source_zip',
  'montage_upload',
])
export type OperationKind = z.infer<typeof OperationKindSchema>

export const OPERATION_LABEL: Record<OperationKind, string> = {
  platform_copy: 'Копия для платформы собирается',
  zip_day: 'Архив дня собирается',
  zip_release: 'Архив выпуска собирается',
  zip_week: 'Архив недели собирается',
  handoff: 'Передача готовится',
  fyp_versions: 'Версии фупа собираются',
  make_photo: 'Фото из кадров собираются',
  make_cover: 'Обложка собирается',
  compat_copy: 'Копия, которая откроется везде, собирается',
  source_zip: 'Исходники собираются',
  montage_upload: 'Монтаж для PPV загружается',
}

export const OperationSchema = z.object({
  id: z.string(),
  kind: OperationKindSchema,
  /** «Передача PRM-015 готовится · 2,6 ГБ». */
  label: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  progress: ProgressSchema,
  created_at: InstantSchema,
  finished_at: InstantSchema.nullable(),
  result: z
    .object({
      download_url: z.string().nullable(),
      file_name: z.string().nullable(),
      size_bytes: z.int().nonnegative().nullable(),
      /** The object the operation made: a PPV accepted once its own montage passed the check. */
      item_id: ItemIdSchema.optional(),
    })
    .nullable(),
  error: ApiErrorBodySchema.nullable(),
})
export type Operation = z.infer<typeof OperationSchema>

/** Body of a 202 answer. */
export const OperationAcceptedSchema = z.object({
  kind: z.literal('operation'),
  operation_id: z.string(),
  status_url: z.string(),
})
export type OperationAccepted = z.infer<typeof OperationAcceptedSchema>

/** A download that is ready at once (the copy was already built). */
export const DownloadReadySchema = z.object({
  kind: z.literal('ready'),
  download_url: z.string(),
  file_name: z.string(),
  size_bytes: z.int().nonnegative(),
})
export type DownloadReady = z.infer<typeof DownloadReadySchema>

export const DownloadAnswerSchema = z.discriminatedUnion('kind', [
  DownloadReadySchema,
  OperationAcceptedSchema,
])
export type DownloadAnswer = z.infer<typeof DownloadAnswerSchema>
