import { z } from 'zod'
import {
  AccountCodeSchema,
  InstantSchema,
  LocalDateSchema,
  LocalTimeSchema,
} from '../domain/common'
import { ItemIdSchema } from '../domain/item-type'
import { UniqLevelSchema } from '../domain/model'
import { CancelReasonSchema, MarkKindSchema, SurfaceKindSchema } from '../domain/placement'
import { PlanRowSchema, PlanWarningSchema, WeekNormSchema } from '../domain/plan'

/** One row to put into the plan: a single object, a batch or a release cell. */
export const NewPlanRowSchema = z.object({
  item_id: ItemIdSchema.nullable(),
  account: AccountCodeSchema,
  surface: SurfaceKindSchema,
  date: LocalDateSchema,
  time: LocalTimeSchema.nullable(),
  fyp_version: z.object({ no: z.int().positive(), level: UniqLevelSchema }).nullable(),
  assignee: z.string().nullable(),
  note: z.string().nullable(),
  requires_new_upload: z.boolean(),
  /** «Под монтаж»: the row waits for a montage from these raw files. */
  awaiting_montage: z
    .object({
      from_item: ItemIdSchema,
      expected_type: z.enum(['fyp', 'ppv', 'teaser']),
      file_keys: z.array(z.string()).min(1),
    })
    .nullable(),
  /** «Уже залито» and «выложено вне плана» create rows already marked. */
  marked: MarkKindSchema.nullable(),
})
export type NewPlanRow = z.infer<typeof NewPlanRowSchema>

/** «Поставить N» — all or nothing; `?dry_run=1` returns the preview. */
export const CreatePlanRowsCommandSchema = z.object({
  rows: z.array(NewPlanRowSchema).min(1),
})
export type CreatePlanRowsCommand = z.infer<typeof CreatePlanRowsCommandSchema>

export const CreatePlanRowsResultSchema = z.object({
  created: z.boolean(),
  rows: z.array(PlanRowSchema),
  /** The rows that stopped the batch, with the reason. */
  rejected: z.array(z.object({ index: z.int().nonnegative(), code: z.string(), text: z.string() })),
})
export type CreatePlanRowsResult = z.infer<typeof CreatePlanRowsResultSchema>

/** The check line under the form (DESIGN §4.13). */
export const RowCheckResultSchema = z.object({
  tone: z.enum(['muted', 'attention']),
  text: z.string(),
  /** The same without the page name: «слишком рано, было 13.09 — 9 дней назад», «не было». */
  page_text: z.string(),
  blocked: z.boolean(),
  warnings: z.array(PlanWarningSchema),
  /**
   * An old object never checked for a second person, put on OnlyFans: «Есть второй человек?
   * · Нет · Есть» — asked once; a person or an agent answers with the object's flag.
   */
  question: z
    .object({ kind: z.literal('second_person'), item_id: ItemIdSchema })
    .nullable()
    .optional(),
})
export type RowCheckResult = z.infer<typeof RowCheckResultSchema>

/** «Выпуск PPV»: the matrix «pages × wall / mass message / story teaser / vault». */
export const CreateReleaseCommandSchema = z.object({
  item_id: ItemIdSchema,
  cells: z
    .array(
      z.object({
        account: AccountCodeSchema,
        surface: SurfaceKindSchema,
        date: LocalDateSchema,
        time: LocalTimeSchema.nullable(),
      }),
    )
    .min(1),
})
export type CreateReleaseCommand = z.infer<typeof CreateReleaseCommandSchema>

export const MarkRowCommandSchema = z.object({
  kind: MarkKindSchema,
  /** Stories and mass messages: time of posting, «сейчас» by default. */
  stated_occurred_at: InstantSchema.nullable(),
})
export type MarkRowCommand = z.infer<typeof MarkRowCommandSchema>

export const MarkConfirmRowCommandSchema = z.object({
  stated_occurred_at: InstantSchema.nullable(),
})
export type MarkConfirmRowCommand = z.infer<typeof MarkConfirmRowCommandSchema>

export const MarkRowsCommandSchema = z.object({
  row_ids: z.array(z.string()).min(1),
  kind: MarkKindSchema,
})
export type MarkRowsCommand = z.infer<typeof MarkRowsCommandSchema>

export const MarkConfirmRowsCommandSchema = z.object({
  row_ids: z.array(z.string()).min(1),
})
export type MarkConfirmRowsCommand = z.infer<typeof MarkConfirmRowsCommandSchema>

export const CancelRowCommandSchema = z.object({ reason: CancelReasonSchema.nullable() })
export type CancelRowCommand = z.infer<typeof CancelRowCommandSchema>

export const MoveRowCommandSchema = z.object({
  date: LocalDateSchema,
  time: LocalTimeSchema.nullable(),
  account: AccountCodeSchema,
})
export type MoveRowCommand = z.infer<typeof MoveRowCommandSchema>

export const UpdateRowCommandSchema = z.object({
  note: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  replace_manifest: z.boolean().optional(),
  /** Publication through Hub (5б): caption, Fansly tiers, price, repeat, vault album name. */
  caption: z.string().nullable().optional(),
  tiers: z.array(z.string().min(1)).nullable().optional(),
  price_mills: z.int().nonnegative().nullable().optional(),
  repost: z.boolean().optional(),
  album: z.string().nullable().optional(),
})
export type UpdateRowCommand = z.infer<typeof UpdateRowCommandSchema>

export const UpdateWeekNormCommandSchema = WeekNormSchema.omit({ account: true, version: true })
export type UpdateWeekNormCommand = z.infer<typeof UpdateWeekNormCommandSchema>

/** «Скачать всё за день», «Скачать выпуск», «Скачать неделю» — a ZIP built as a long operation. */
export const PlanDownloadCommandSchema = z.object({
  scope: z.enum(['day', 'release', 'week']),
  date: LocalDateSchema.nullable(),
  week: z.string().nullable(),
  release_id: z.string().nullable(),
  account: AccountCodeSchema.nullable(),
  /** «Мои» в дне: только строки, которые выкладывает сам человек, — как объём у кнопки. */
  mine: z.boolean().optional(),
  strip_metadata: z.boolean(),
})
export type PlanDownloadCommand = z.infer<typeof PlanDownloadCommandSchema>
