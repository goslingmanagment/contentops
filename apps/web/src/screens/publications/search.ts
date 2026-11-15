import { PublicationWindowSchema } from '@contentops/contracts'
import { z } from 'zod'

/**
 * «Публикации»: `?window=next7|next30|last7|last30|all`, `?status=draft|unknown|not_out|…`, `?page=<страница Hub>`,
 * `?post=<номер>` — пост в панели. Старые адреса Hub приходят с `publication=`: тот же пост.
 */
export const publicationsSearchSchema = z.object({
  window: PublicationWindowSchema.optional().catch(undefined),
  status: z.string().max(40).optional().catch(undefined),
  page: z.string().max(100).optional().catch(undefined),
  post: z.coerce.number().int().positive().optional().catch(undefined),
  publication: z.coerce.number().int().positive().optional().catch(undefined),
})
export type PublicationsSearch = z.infer<typeof publicationsSearchSchema>
