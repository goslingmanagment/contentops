import { z } from 'zod'

/** «Новое» показывается крупной плиткой или списком (DESIGN §4.8): `?view=list`. */
export const InboxViewSchema = z.enum(['large', 'list'])
export type InboxView = z.infer<typeof InboxViewSchema>

export const inboxSearchSchema = z.object({
  view: InboxViewSchema.optional().catch(undefined),
})

/** «Решённое»: чип «Принятые · Отклонённые» (DESIGN §4.10): `?show=rejected`. */
export const DecidedShowSchema = z.enum(['accepted', 'rejected'])
export type DecidedShow = z.infer<typeof DecidedShowSchema>

export const inboxDoneSearchSchema = z.object({
  show: DecidedShowSchema.optional().catch(undefined),
})
