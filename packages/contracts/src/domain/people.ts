import { z } from 'zod'
import { GenderSchema, InstantSchema, ModelCodeSchema, RecordVersionSchema } from './common'
import { PlatformSchema } from './model'

/** Three roles (SPEC §11.1); rights are a role plus a list of models. */
export const RoleSchema = z.enum(['owner', 'manager', 'reader'])
export type Role = z.infer<typeof RoleSchema>

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец',
  manager: 'Контент-менеджер',
  reader: 'Только чтение',
}

export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  login: z.string(),
  gender: GenderSchema,
  role: RoleSchema,
  models: z.array(ModelCodeSchema),
  /** Platforms the person usually posts to; drives «кто выкладывает». */
  posts_on: z.array(PlatformSchema),
  sessions: z.int().nonnegative(),
  last_seen_at: InstantSchema.nullable(),
  /** Role and models change with `If-Match` (Настройки › Люди и доступ). */
  version: RecordVersionSchema,
})
export type Person = z.infer<typeof PersonSchema>

/** The principal behind the current session, with the models it may see. */
export const SessionPrincipalSchema = z.object({
  person: PersonSchema,
  models: z.array(ModelCodeSchema),
})
export type SessionPrincipal = z.infer<typeof SessionPrincipalSchema>
