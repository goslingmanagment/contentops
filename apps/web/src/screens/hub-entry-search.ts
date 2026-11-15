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

export type HubEntryTarget =
  | { kind: 'model'; model: string }
  | { kind: 'missing'; asked: string }
  | { kind: 'none' }

/**
 * Where Hub's old address lands: the model Hub names, mapped here (`hub_models`), when it is one of the person's; a
 * model Hub names that is not one of them — said on a page, never another model's screen; no model named — the one
 * the person was on last, else their first.
 */
export function hubEntryTarget(input: {
  asked: string | undefined
  hubModels: Readonly<Record<string, string>> | undefined
  models: readonly string[]
  last: string | null
}): HubEntryTarget {
  const asked = input.asked?.trim().toLowerCase()
  if (asked) {
    const mapped = input.hubModels?.[asked] ?? asked
    return input.models.includes(mapped)
      ? { kind: 'model', model: mapped }
      : { kind: 'missing', asked }
  }
  const model =
    (input.last && input.models.includes(input.last) ? input.last : undefined) ?? input.models[0]
  return model ? { kind: 'model', model } : { kind: 'none' }
}
