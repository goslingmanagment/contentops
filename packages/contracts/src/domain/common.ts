import { z } from 'zod'

/** Instant in UTC, ISO 8601 (`2026-09-22T11:20:00Z`). The screen shows it in Europe/Moscow. */
export const InstantSchema = z.iso.datetime({ offset: true })
export type Instant = z.infer<typeof InstantSchema>

/** Calendar date in Europe/Moscow (`2026-09-22`). */
export const LocalDateSchema = z.iso.date()
export type LocalDate = z.infer<typeof LocalDateSchema>

/** Wall-clock time in Europe/Moscow (`03:00`). */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export type LocalTime = z.infer<typeof LocalTimeSchema>

/** ISO week (`2026-W39`). */
export const IsoWeekSchema = z.string().regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/)
export type IsoWeek = z.infer<typeof IsoWeekSchema>

export const ModelCodeSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)
export type ModelCode = z.infer<typeof ModelCodeSchema>

/** Page code, e.g. `lora-2`, `lora-vip-of`. */
export const AccountCodeSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)
export type AccountCode = z.infer<typeof AccountCodeSchema>

/** Record version, sent back as `ETag` and expected in `If-Match`. */
export const RecordVersionSchema = z.int().positive()
export type RecordVersion = z.infer<typeof RecordVersionSchema>

/** The three signs of the state language (DESIGN §5.1): ✓ done, ◆ your turn, ▲ trouble. */
export const SignSchema = z.enum(['done', 'turn', 'trouble'])
export type Sign = z.infer<typeof SignSchema>

export const GenderSchema = z.enum(['f', 'm'])
export type Gender = z.infer<typeof GenderSchema>

export const ActorTypeSchema = z.enum(['person', 'agent', 'system'])
export type ActorType = z.infer<typeof ActorTypeSchema>

/** Who did something: a person, an agent or the system. `name` is ready for the screen. */
export const ActorRefSchema = z.object({
  type: ActorTypeSchema,
  id: z.string().nullable(),
  name: z.string(),
  gender: GenderSchema.nullable(),
})
export type ActorRef = z.infer<typeof ActorRefSchema>

/** Pointer to a synthetic or real thumbnail. In the product `key` carries the content hash. */
export const ThumbRefSchema = z.object({
  key: z.string().min(1),
  ratio: z.enum(['3:4', '9:16', '16:9', '1:1']),
  /**
   * The real thumbnail: `/api/v1/<model>/g/<generation>/thumb-640.webp` (SPEC §9.3, §11.2);
   * absent or `null` while it is not built — the screen draws the synthetic cover.
   */
  url: z.string().nullable().optional(),
})
export type ThumbRef = z.infer<typeof ThumbRefSchema>

/** A word with an optional sign, as every state is shown on screen. */
export const StatusWordSchema = z.object({
  sign: SignSchema.nullable(),
  word: z.string(),
  detail: z.string().nullable(),
})
export type StatusWord = z.infer<typeof StatusWordSchema>

export const ProgressSchema = z.number().min(0).max(1)
