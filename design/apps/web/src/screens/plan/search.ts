import { AccountCodeSchema, IsoWeekSchema } from '@contentops/contracts'
import { z } from 'zod'
import { SearchFlagSchema, SearchListSchema } from '@/app/search-params'

/**
 * День плана: `?mine=1&by=time` (DESIGN §2.4); `pages` — чип «Все страницы ▾»,
 * `show=cancelled` — «⋯ → Отменённые». Без `mine` чип стоит по роли: у КМ включён.
 */
export const planDaySearchSchema = z.object({
  mine: SearchFlagSchema.optional().catch(undefined),
  by: z.enum(['time', 'page']).optional().catch(undefined),
  pages: SearchListSchema.pipe(z.array(AccountCodeSchema)).optional().catch(undefined),
  show: z.enum(['cancelled']).optional().catch(undefined),
})
export type PlanDaySearch = z.infer<typeof planDaySearchSchema>

/** Неделя: второй вид `?variant=pages` (DESIGN §9.1), страница второго вида — `page`. */
export const planWeekSearchSchema = z.object({
  variant: z.enum(['pages']).optional().catch(undefined),
  page: AccountCodeSchema.optional().catch(undefined),
})
export type PlanWeekSearch = z.infer<typeof planWeekSearchSchema>

/** «Сверить»: `?show=done`, `?show=not-ours`; чипы «Страница ▾» и «Неделя ▾» — `page`, `week`. */
export const planCheckSearchSchema = z.object({
  show: z.enum(['done', 'not-ours']).optional().catch(undefined),
  page: AccountCodeSchema.optional().catch(undefined),
  week: IsoWeekSchema.optional().catch(undefined),
})
export type PlanCheckSearch = z.infer<typeof planCheckSearchSchema>
