import { z } from 'zod'
import { AccountCodeSchema, InstantSchema, ThumbRefSchema } from './common'

/** One root of the old Я.Диск in the order of SPEC. */
export const LegacyRootSchema = z.object({
  root: z.string(),
  accepted: z.int().nonnegative().nullable(),
  old_names: z.int().nonnegative().nullable(),
  disputed: z.int().nonnegative(),
  /** Files still waiting; `null` — «идут». */
  waiting: z.int().nonnegative().nullable(),
})
export type LegacyRoot = z.infer<typeof LegacyRootSchema>

export const LegacyProgressSchema = z.object({
  processed_folders: z.int().nonnegative(),
  total_folders: z.int().nonnegative(),
  old_names: z.int().nonnegative(),
  unresolved: z.int().nonnegative(),
  roots: z.array(LegacyRootSchema),
  /** ▲ «Импорт стоит: мало места (100 ГБ)». */
  stalled: z.string().nullable(),
})
export type LegacyProgress = z.infer<typeof LegacyProgressSchema>

/** Where an old label points: one page, several pages or «номер поста дня». */
export const LabelTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accounts'), accounts: z.array(AccountCodeSchema).min(1) }),
  z.object({ kind: z.literal('post_number') }),
])
export type LabelTarget = z.infer<typeof LabelTargetSchema>

export const LabelMappingSchema = z.object({
  label: z.string(),
  examples: z.array(z.object({ name: z.string(), thumb: ThumbRefSchema })),
  target: LabelTargetSchema.nullable(),
})
export type LabelMapping = z.infer<typeof LabelMappingSchema>

export const DisputeKindSchema = z.enum([
  'number_taken',
  'number_typo',
  'number_no_trace',
  'short_shoot',
  'ppv_from_custom',
  'label_from_name',
  'cross_model',
  'archive_broken',
  'foreign_archive',
])
export type DisputeKind = z.infer<typeof DisputeKindSchema>

export const DISPUTE_KIND_LABEL: Record<DisputeKind, string> = {
  number_taken: 'Номер занят',
  number_typo: 'Опечатка номера',
  number_no_trace: 'Номер без следов',
  short_shoot: 'Короткая съёмка',
  ppv_from_custom: 'PPV из кастома?',
  label_from_name: 'Метка из имени',
  cross_model: 'Межмодельный дубль',
  archive_broken: 'Неполный архив',
  foreign_archive: 'Архив другой модели',
}

export const DisputeOptionSchema = z.object({
  key: z.string(),
  label: z.string(),
})
export type DisputeOption = z.infer<typeof DisputeOptionSchema>

/** One folder of «Номер занят» with what the proposal does to it: `keep` or `new_number`. */
export const DisputeFolderSchema = z.object({
  name: z.string(),
  thumb: ThumbRefSchema,
  proposal: z.string(),
})
export type DisputeFolder = z.infer<typeof DisputeFolderSchema>

export const DisputeSchema = z.object({
  id: z.string(),
  kind: DisputeKindSchema,
  root: z.string(),
  /** «PPV-032 у трёх папок». */
  title: z.string(),
  /** Old name fragment, shown monospace. */
  fragment: z.string().nullable(),
  thumbs: z.array(ThumbRefSchema),
  /** «Метка из имени»: the old label (`used3`); a saved card «Метки → страницы» settles it. */
  label: z.string().nullable(),
  /** «Номер занят»: the folders, each with its own choice (DESIGN §4.9). */
  folders: z.array(DisputeFolderSchema),
  /** Ready proposal by the norm, button «Так и сделать»; `null` when there is none. */
  proposal: z.string().nullable(),
  options: z.array(DisputeOptionSchema),
  /** Case without an action: «Отложено до подключения Ари». */
  postponed: z.string().nullable(),
  resolved: z.object({ option: z.string(), by: z.string(), at: InstantSchema }).nullable(),
})
export type Dispute = z.infer<typeof DisputeSchema>

/** `GET /api/v1/<model>/legacy` */
export const LegacyReviewSchema = z.object({
  progress: LegacyProgressSchema,
  labels: z.array(LabelMappingSchema),
  disputes: z.array(DisputeSchema),
})
export type LegacyReview = z.infer<typeof LegacyReviewSchema>
