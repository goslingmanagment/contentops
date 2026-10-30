import { FanNameSchema } from '@contentops/contracts'
import { z } from 'zod'
import { SearchFlagSchema } from '@/app/search-params'

/** «Сдано ▾» в «Переделке в PPV»: за неделю, за месяц или раньше. */
export const DeliveredWithinSchema = z.enum(['week', 'month', 'older'])
export type DeliveredWithin = z.infer<typeof DeliveredWithinSchema>

/**
 * Параметры заказов и «Переделки в PPV» в адресе раздела «Кастомы» (DESIGN §2.4):
 * `?view=orders&tab=closed`, `?view=to-ppv&todo=1&name=no&delivered=week`. Раздел
 * «Кастомы» — папка Библиотеки, поэтому схема подмешивается в его адрес.
 */
export const ordersSearchShape = {
  tab: z.enum(['closed', 'cancelled']).optional().catch(undefined),
  /** «Найти заказ»: покупатель, название, ТЗ — сразу во всех вкладках. */
  q: z.string().optional().catch(undefined),
  /** «Не сделано»: только кастомы, из которых PPV ещё нет. */
  todo: SearchFlagSchema.optional().catch(undefined),
  /** «Имя ▾»: есть / нет / не знаю. */
  name: FanNameSchema.optional().catch(undefined),
  delivered: DeliveredWithinSchema.optional().catch(undefined),
}
