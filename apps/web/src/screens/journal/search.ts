import {
  ActorTypeSchema,
  ItemIdSchema,
  JournalAreaSchema,
  JournalResultSchema,
} from '@contentops/contracts'
import { z } from 'zod'

/** «Период» журнала: как в «Истории» Я.Диска — от сегодня назад. */
export const JournalPeriodSchema = z.enum(['today', 'yesterday', 'week', 'month'])
export type JournalPeriod = z.infer<typeof JournalPeriodSchema>

/**
 * Фильтры журнала живут в адресе: `?who=agent&item=PPV-073` (DESIGN §2.4, §4.18).
 * `who` — кто, `what` — область, `result` — выполнено, отказ или ошибка.
 */
export const journalSearchSchema = z.object({
  who: ActorTypeSchema.optional().catch(undefined),
  what: JournalAreaSchema.optional().catch(undefined),
  item: ItemIdSchema.optional().catch(undefined),
  result: JournalResultSchema.optional().catch(undefined),
  period: JournalPeriodSchema.optional().catch(undefined),
})
export type JournalSearch = z.infer<typeof journalSearchSchema>
