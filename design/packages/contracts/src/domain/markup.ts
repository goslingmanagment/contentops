import { z } from 'zod'
import { InstantSchema, RecordVersionSchema } from './common'

/** Three tag groups (SPEC §5): actions, attributes, mood. */
export const TagGroupSchema = z.enum(['action', 'attribute', 'mood'])
export type TagGroup = z.infer<typeof TagGroupSchema>

export const TAG_GROUP_LABEL: Record<TagGroup, string> = {
  action: 'действия',
  attribute: 'атрибуты',
  mood: 'настроение',
}

/** Dictionary entry; a free tag has no group and may have no Russian name. */
export const TagSchema = z.object({
  key: z.string().min(1),
  ru: z.string().nullable(),
  group: TagGroupSchema.nullable(),
  uses: z.int().nonnegative(),
  /** Russian name and group change with `If-Match` (Настройки › Теги). */
  version: RecordVersionSchema,
})
export type Tag = z.infer<typeof TagSchema>

export const MarkupFieldKeySchema = z.enum([
  'title',
  'tags',
  'description',
  'timeline',
  'platform_texts',
])
export type MarkupFieldKey = z.infer<typeof MarkupFieldKeySchema>

export const MARKUP_FIELD_LABEL: Record<MarkupFieldKey, string> = {
  title: 'Название',
  tags: 'Теги',
  description: 'Описание',
  timeline: 'Хронология',
  platform_texts: 'Тексты для платформы (EN)',
}

/** State of one markup field (DESIGN §5.4). */
export const FieldStatusSchema = z.enum([
  'empty',
  'draft_ai',
  'draft_import',
  'confirmed',
  'confirmed_previous_version',
  'ai_failed',
])
export type FieldStatus = z.infer<typeof FieldStatusSchema>

export const TimelineSegmentSchema = z.object({
  start_s: z.number().nonnegative(),
  label: z.string().min(1),
})
export type TimelineSegment = z.infer<typeof TimelineSegmentSchema>

export const PlatformTextsSchema = z.object({
  wall: z.string(),
  message: z.string(),
})

export const MarkupValueSchema = z.discriminatedUnion('key', [
  z.object({ key: z.literal('title'), value: z.string() }),
  z.object({ key: z.literal('tags'), value: z.array(z.string()) }),
  z.object({ key: z.literal('description'), value: z.string() }),
  z.object({ key: z.literal('timeline'), value: z.array(TimelineSegmentSchema) }),
  z.object({ key: z.literal('platform_texts'), value: PlatformTextsSchema.nullable() }),
])
export type MarkupValue = z.infer<typeof MarkupValueSchema>

export const MarkupFieldSchema = z.object({
  field: MarkupValueSchema,
  status: FieldStatusSchema,
  /** Version of this field; confirming sends exactly the versions seen on screen. */
  version: RecordVersionSchema,
  confirmed_by: z.string().nullable(),
  confirmed_at: InstantSchema.nullable(),
  /** Where the value came from, shown on hover: «из имени папки», «из старого имени». */
  source_hint: z.string().nullable(),
})
export type MarkupField = z.infer<typeof MarkupFieldSchema>

/** Summary state of the whole markup, a field of the catalog index. */
export const MarkupStateSchema = z.enum(['draft', 'partial', 'confirmed'])
export type MarkupState = z.infer<typeof MarkupStateSchema>

export function summarizeMarkup(fields: readonly Pick<MarkupField, 'status'>[]): MarkupState {
  const filled = fields.filter((field) => field.status !== 'empty')
  const confirmed = filled.filter((field) => field.status === 'confirmed')
  if (filled.length > 0 && confirmed.length === filled.length) return 'confirmed'
  return confirmed.length > 0 ? 'partial' : 'draft'
}
