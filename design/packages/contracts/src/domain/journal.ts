import { z } from 'zod'
import { ActorRefSchema, ActorTypeSchema, InstantSchema, ThumbRefSchema } from './common'
import { ItemIdSchema } from './item-type'

/** Areas of «Что» in the journal filter. */
export const JournalAreaSchema = z.enum([
  'inbox',
  'catalog',
  'plan',
  'check',
  'orders',
  'promo',
  'settings',
  'system',
])
export type JournalArea = z.infer<typeof JournalAreaSchema>

export const JOURNAL_AREA_LABEL: Record<JournalArea, string> = {
  inbox: 'Приёмка',
  catalog: 'Каталог',
  plan: 'План',
  check: 'Сверка',
  orders: 'Заказы',
  promo: 'Промо',
  settings: 'Настройки',
  system: 'Система',
}

export const JournalResultSchema = z.enum(['ok', 'denied', 'error'])
export type JournalResult = z.infer<typeof JournalResultSchema>

/** One event of `action_log` as the journal shows it. */
export const JournalEventSchema = z.object({
  id: z.string(),
  at: InstantSchema,
  actor: ActorRefSchema,
  area: JournalAreaSchema,
  /** Machine name: `draft.accept`, `placement.confirm`. */
  action: z.string(),
  /** «Диана приняла SET-073 из «4. Sets/19.09.26»». */
  phrase: z.string(),
  item_id: ItemIdSchema.nullable(),
  thumb: ThumbRefSchema.nullable(),
  result: JournalResultSchema,
  changes: z.array(z.object({ field: z.string(), before: z.string(), after: z.string() })),
  request_id: z.string(),
})
export type JournalEvent = z.infer<typeof JournalEventSchema>

export const JournalFilterSchema = z.object({
  actor_type: ActorTypeSchema.optional(),
  area: JournalAreaSchema.optional(),
  item: ItemIdSchema.optional(),
  result: JournalResultSchema.optional(),
  from: InstantSchema.optional(),
  to: InstantSchema.optional(),
})
export type JournalFilter = z.infer<typeof JournalFilterSchema>
