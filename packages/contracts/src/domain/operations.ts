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
  'verify_blobs',
  'legacy_parse',
  'legacy_plan',
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
  verify_blobs: 'Проверка хранилища',
  legacy_parse: 'Разбор старых имён по снимку',
  legacy_plan: 'Сухой прогон импорта',
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
  /**
   * Report of a service run: `verify-blobs` — hashes, missing files, blobs without references;
   * the legacy pass and its dry run — numbers, collisions, labels, unparsed names (SPEC §6.3).
   */
  report: z.record(z.string(), z.unknown()).nullable().optional(),
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
