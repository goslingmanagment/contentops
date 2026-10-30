import { z } from 'zod'
import { FanNameSchema, PpvKindSchema, RawPurposeSchema } from './catalog'
import {
  ActorRefSchema,
  InstantSchema,
  LocalDateSchema,
  ModelCodeSchema,
  ProgressSchema,
  RecordVersionSchema,
  ThumbRefSchema,
} from './common'
import { FileRoleSchema, MediaKindSchema } from './files'
import { ItemIdSchema, ItemTypeSchema } from './item-type'

/** Stages of «готовится» (DESIGN §5.3). */
export const PreparingStageSchema = z.enum([
  'discovered',
  'downloading',
  'preview',
  'compressing',
  'checking',
])
export type PreparingStage = z.infer<typeof PreparingStageSchema>

/** ◆ «нужно решение». */
export const DecisionKindSchema = z.enum([
  'which_order',
  'video_in_set',
  'what_is_it',
  'number_taken',
  'cross_model',
  'substitute_montage',
  /** A readable archive with several shoots inside: accepted by its folders, not as one. */
  'split_archive',
  /** A processed frame whose download name is unknown: which frame of the set it is. */
  'which_frame',
])
export type DecisionKind = z.infer<typeof DecisionKindSchema>

export const DECISION_LABEL: Record<DecisionKind, string> = {
  which_order: 'Какой заказ?',
  video_in_set: 'Видео среди фото — куда?',
  what_is_it: 'Что это?',
  number_taken: 'Номер занят',
  cross_model: 'Такой файл есть у другой модели',
  substitute_montage: 'Подставить монтаж в строку?',
  split_archive: 'Разделить архив?',
  which_frame: 'К какому кадру?',
}

/** ▲ «ошибка». */
export const DraftErrorKindSchema = z.enum([
  'master_failed',
  'vanished',
  'archive_unreadable',
  'upload_failed',
])
export type DraftErrorKind = z.infer<typeof DraftErrorKindSchema>

/** What «готово» adds after the word: «дополнит SET-074», «часть заказа: видео». */
export const ReadyNoteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }),
  z.object({ kind: z.literal('extends'), item_id: ItemIdSchema }),
  z.object({ kind: z.literal('order_part'), order_id: z.string(), part: z.string() }),
  z.object({ kind: z.literal('fix_of'), item_id: ItemIdSchema, revision_id: z.string() }),
  z.object({ kind: z.literal('promo'), channel: z.string() }),
])
export type ReadyNote = z.infer<typeof ReadyNoteSchema>

export const VideoInSetDestinationSchema = z.enum([
  'raw',
  'life',
  'fyp_source',
  'separate',
  'reject',
])
export type VideoInSetDestination = z.infer<typeof VideoInSetDestinationSchema>

export const AcceptHowSchema = z.enum(['new', 'extend', 'duplicate', 'upload', 'delivery', 'fix'])
export type AcceptHow = z.infer<typeof AcceptHowSchema>

export const DraftStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('preparing'),
    stage: PreparingStageSchema,
    progress: ProgressSchema.nullable(),
    done_bytes: z.int().nonnegative().nullable(),
    total_bytes: z.int().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal('ready'), note: ReadyNoteSchema }),
  z.object({ kind: z.literal('decision'), decision: DecisionKindSchema }),
  z.object({ kind: z.literal('error'), error: DraftErrorKindSchema, detail: z.string() }),
  z.object({
    kind: z.literal('accepted'),
    item_id: ItemIdSchema,
    how: AcceptHowSchema,
    /** Exact duplicate: the file it matched, ✓ «уже есть: SET-069/ed07». */
    file_key: z.string().optional(),
    by: ActorRefSchema,
    at: InstantSchema,
  }),
  z.object({
    kind: z.literal('rejected'),
    reason: z.string().nullable(),
    by: ActorRefSchema,
    at: InstantSchema,
    days_left: z.int().nonnegative(),
  }),
])
export type DraftState = z.infer<typeof DraftStateSchema>

/** Fields of the draft as the decision panel edits them. */
export const DraftFieldsSchema = z.object({
  type: ItemTypeSchema.nullable(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  ppv_kind: PpvKindSchema.nullable(),
  raw_purpose: RawPurposeSchema.nullable(),
  channel: z.string().nullable(),
  /** `new` or an existing collection `PRM-015`. */
  collection: z.string().nullable(),
  second_person: z.boolean(),
  fan_name: FanNameSchema.nullable(),
  order_id: z.string().nullable(),
  shot_on: LocalDateSchema.nullable(),
})
export type DraftFields = z.infer<typeof DraftFieldsSchema>

export const DraftFileSchema = z.object({
  key: z.string(),
  file_name: z.string(),
  role: FileRoleSchema,
  /** «мастер», «тизер», «фото 3». */
  role_label: z.string(),
  media: MediaKindSchema,
  position: z.int().positive().nullable(),
  duration_s: z.number().nonnegative().nullable(),
  size_bytes: z.int().nonnegative(),
  thumb: ThumbRefSchema,
  shot_at: InstantSchema.nullable(),
})
export type DraftFile = z.infer<typeof DraftFileSchema>

export const DraftHintSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('similar'),
    text: z.string(),
    item_id: ItemIdSchema,
    file_key: z.string(),
  }),
  z.object({ kind: z.literal('duration_mismatch'), text: z.string() }),
  z.object({ kind: z.literal('order_match'), text: z.string() }),
  z.object({ kind: z.literal('changed_after_snapshot'), text: z.string() }),
  /** The same file at another model; only someone with rights on both models receives it. */
  z.object({ kind: z.literal('other_model'), model: ModelCodeSchema, text: z.string() }),
  /** ◆ «Подставить монтаж в строку?»: the plan row as the upload saw it and as it is now. */
  z.object({ kind: z.literal('row_change'), was: z.string(), now: z.string() }),
])
export type DraftHint = z.infer<typeof DraftHintSchema>

/** A candidate order for ◆ «Какой заказ?»: no preselection. */
export const OrderCandidateSchema = z.object({
  order_id: z.string(),
  title: z.string(),
  deadline: LocalDateSchema.nullable(),
  excerpt: z.string(),
  matched: z.array(z.string()),
})
export type OrderCandidate = z.infer<typeof OrderCandidateSchema>

/** A group of «Приехало»: one pack from Я.Диск or one web upload. */
export const InboxGroupSchema = z.object({
  id: z.string(),
  /** As the model named it: «2:54 грудь попа». */
  title: z.string(),
  source_path: z.string(),
  root: z.string(),
  /** A web upload: who uploaded it through the browser; `null` for what came from Я.Диск. */
  uploaded_by: ActorRefSchema.nullable(),
  arrived_at: InstantSchema,
  size_bytes: z.int().nonnegative(),
  file_count: z.int().nonnegative(),
  state: DraftStateSchema,
  /** One line under a disabled «Принять»: «Сначала выберите заказ». */
  accept_block: z.string().nullable(),
  fields: DraftFieldsSchema,
  hints: z.array(DraftHintSchema),
  files: z.array(DraftFileSchema),
  candidates: z.array(OrderCandidateSchema),
  /** Groups under the drafts of a readable archive, shown as a table of contents. */
  archive_entries: z.int().nonnegative().nullable(),
  /**
   * ◆ «К какому кадру?» (SPEC §6.1): the file being matched and the frames of the set,
   * similar by pHash first. Absent for every other state.
   */
  frame_choices: z
    .object({
      file_key: z.string(),
      frames: z.array(
        z.object({
          /** Handle of the source frame: `raw07`. */
          key: z.string(),
          label: z.string(),
          thumb: ThumbRefSchema,
          /** Close by pHash: shown first. */
          similar: z.boolean(),
        }),
      ),
    })
    .nullable()
    .optional(),
  /**
   * The object a web upload with a target was meant for, or the object the pack extends:
   * «Загрузить заново» after ▲ goes to the same object.
   */
  target_item: ItemIdSchema.nullable(),
  version: RecordVersionSchema,
})
export type InboxGroup = z.infer<typeof InboxGroupSchema>

export const InboxSectionSchema = z.enum(['decision', 'ready', 'preparing'])
export type InboxSection = z.infer<typeof InboxSectionSchema>

export function inboxSectionOf(state: DraftState): InboxSection | null {
  switch (state.kind) {
    case 'decision':
    case 'error':
      return 'decision'
    case 'ready':
      return 'ready'
    case 'preparing':
      return 'preparing'
    default:
      return null
  }
}

/** `GET /api/v1/<model>/inbox` */
export const InboxListSchema = z.object({
  items: z.array(InboxGroupSchema),
  next_cursor: z.string().nullable(),
  /** Decision plus ready: the same number on the tab and in the column. */
  count: z.int().nonnegative(),
  disk_checked_at: InstantSchema.nullable(),
  /** «Разбор старого · 38» is shown while this is above zero. */
  legacy_disputes: z.int().nonnegative(),
})
export type InboxList = z.infer<typeof InboxListSchema>

export const AcceptResultSchema = z.object({
  item_id: ItemIdSchema,
  how: AcceptHowSchema,
  /** Next step by type, for the action strip: «Отобрать кадры», «В план». */
  next_step: z.string().nullable(),
})
export type AcceptResult = z.infer<typeof AcceptResultSchema>

/** Answer to a finished web upload (`POST /api/v1/<model>/uploads`, DESIGN §3.7). */
export const UploadResultSchema = z.object({
  /** The group in «Приехало» («Загружено вами») or the accepted record in «Решённое». */
  group_id: z.string(),
  /** `inbox` — waits in «Приехало»; `attached` — accepted into the target by itself. */
  placed: z.enum(['inbox', 'attached']),
  /** The object the files joined; for a row waiting for a montage — the new object. */
  item_id: ItemIdSchema.nullable(),
  /** ◆ of a group in «Приехало»: «Что это?» when the type was not chosen. */
  decision: DecisionKindSchema.nullable(),
})
export type UploadResult = z.infer<typeof UploadResultSchema>
/**
 * `POST /api/v1/<model>/inbox/groups:accept`: per group, like every batch, plus what an
 * accepted group became — the strip names each one: «Принято: SET-075, + в SET-074».
 */
export const AcceptManyResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      code: z.string().nullable(),
      accepted: AcceptResultSchema.nullable(),
    }),
  ),
})
export type AcceptManyResult = z.infer<typeof AcceptManyResultSchema>

/**
 * A group the batch leaves alone: «похоже на исправление» becomes a new master version and
 * closes the revision, so someone has to look at it and accept it on its own (DESIGN §4.8).
 */
export function needsOwnAccept(group: InboxGroup): boolean {
  return group.state.kind === 'ready' && group.state.note.kind === 'fix_of'
}
