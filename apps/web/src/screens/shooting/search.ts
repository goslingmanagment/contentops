import { z } from 'zod'

/**
 * «Съёмка» `/<модель>/shooting` (пакет C3): вкладка `tab` — «Кастомы» (по умолчанию) или «ТЗ»;
 * `order` — заказ Hub в панели (`K-12`).
 */
export const shootingSearchSchema = z.object({
  tab: z.enum(['customs', 'tasks']).optional().catch(undefined),
  order: z.string().optional().catch(undefined),
})
export type ShootingSearch = z.infer<typeof shootingSearchSchema>
