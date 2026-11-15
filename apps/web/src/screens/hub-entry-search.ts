import { z } from 'zod'
import { type PublicationsSearch, publicationsSearchSchema } from '@/screens/publications/search'
import { type StatsSearch, statsSearchSchema } from '@/screens/stats/search'

/**
 * `/hub/<экран>` — вход со старых адресов Hub (пакет C2): `model` — модель Hub, остальное — параметры экрана, как их
 * пишет Hub (`hub/apps/runtime/src/services/content-screens-moved.ts`).
 */
export const hubEntrySearchSchema = z.object({
  model: z.coerce.string().max(80).optional().catch(undefined),
  window: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  page: z.string().optional().catch(undefined),
  post: z.coerce.number().optional().catch(undefined),
  panel: z.string().optional().catch(undefined),
  days: z.coerce.number().optional().catch(undefined),
  media: z.coerce.string().optional().catch(undefined),
})
export type HubEntrySearch = z.infer<typeof hubEntrySearchSchema>

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T

export function publicationsSearchOf(search: Omit<HubEntrySearch, 'model'>): PublicationsSearch {
  const { window, status, page, post, panel } = search
  return defined(publicationsSearchSchema.parse({ window, status, page, post, panel }))
}

export function statsSearchOf(search: Omit<HubEntrySearch, 'model'>): StatsSearch {
  const { page, days, media } = search
  return defined(statsSearchSchema.parse({ page, days, media }))
}
