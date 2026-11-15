import { z } from 'zod'

/** «Статистика»: `?page=<страница Hub>`, `?days=7|30|90|180|365`, `?media=<номер медиа>` — карточка медиа в панели. */
export const statsSearchSchema = z.object({
  page: z.string().max(100).optional().catch(undefined),
  days: z.coerce
    .number()
    .int()
    .refine((value) => [7, 30, 90, 180, 365].includes(value))
    .optional()
    .catch(undefined),
  // Номер медиа — цифры: адрес читает их числом, поэтому строкой его делаем здесь.
  media: z.coerce
    .string()
    .regex(/^\d{1,30}$/)
    .optional()
    .catch(undefined),
})
export type StatsSearch = z.infer<typeof statsSearchSchema>
