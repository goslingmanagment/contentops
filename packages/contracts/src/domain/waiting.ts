import { z } from 'zod'
import { InstantSchema } from './common'

/**
 * «Ждут вас» (products plan §2.4, §4.4): the person's open matters from Agency Hub of the kinds that are
 * ContentOps' (a custom shooting late at the model, a week to approve, a custom copy outside its folder,
 * a publication waiting) — read through the person's own sign-in through Hub, kept a minute, never
 * copied into the database. Each opens where it is decided. ContentOps' own lines («Сверить 8»,
 * «Приехало: нужно решение 1») come from its own reads on the screen.
 */
export const HubMatterSchema = z.object({
  id: z.int().positive(),
  kind: z.string(),
  title: z.string(),
  /** Where it is decided: an absolute address (Hub, Workboard or a path of ContentOps). */
  href: z.string(),
  /** Hub's page labels of the matter; none — the whole model. */
  pages: z.array(z.string()),
  opened_at: InstantSchema,
})
export type HubMatter = z.infer<typeof HubMatterSchema>

export const WaitingSchema = z.object({
  /**
   * `ok` — Hub answered; `unreachable` — Hub did not answer (the list is empty, not «nothing»);
   * `no_hub` — this session did not come through Hub (a password, an agent): Hub's matters are not read.
   */
  hub: z.enum(['ok', 'unreachable', 'no_hub']),
  matters: z.array(HubMatterSchema),
})
export type Waiting = z.infer<typeof WaitingSchema>
