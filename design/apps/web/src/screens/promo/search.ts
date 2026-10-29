import { z } from 'zod'

/** Промо: каналы или список передач (`#/<модель>/library/promo?view=handoffs`). */
export const promoSearchSchema = z.object({
  view: z.enum(['handoffs']).optional().catch(undefined),
})
