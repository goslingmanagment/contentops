import { z } from 'zod'

/**
 * После входа — тот же адрес (DESIGN §3.10): `/login?from=/lora/library/ppv?kind=dm`.
 * Только свой путь: `//` в начале — уже чужой сайт.
 */
export const loginSearchSchema = z.object({
  from: z
    .string()
    .refine((from) => from.startsWith('/') && !from.startsWith('//'), 'Только свой адрес')
    .optional()
    .catch(undefined),
  /** Вход через хаб не открыл сессию (SPEC §11.1): почему — сервер пишет сюда. */
  hub: z.enum(['no_access', 'failed', 'unreachable']).optional().catch(undefined),
})
