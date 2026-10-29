import { z } from 'zod'
import { InstantSchema, ModelCodeSchema } from './common'
import { RoleSchema } from './people'

/** Bearer token of an agent; the secret itself is shown once and never stored. */
export const AgentTokenSchema = z.object({
  id: z.string(),
  /** First characters of the secret, enough to recognise the token. */
  prefix: z.string(),
  issued_at: InstantSchema,
  expires_at: InstantSchema.nullable(),
  last_used_at: InstantSchema.nullable(),
  revoked_at: InstantSchema.nullable(),
})
export type AgentToken = z.infer<typeof AgentTokenSchema>

export const AgentSchema = z.object({
  id: z.string(),
  /** «Приёмка», «Заказы», «Импорт». */
  name: z.string(),
  role: RoleSchema,
  models: z.array(ModelCodeSchema),
  tokens: z.array(AgentTokenSchema),
})
export type Agent = z.infer<typeof AgentSchema>

/** Response of «Выдать токен»: the only moment the secret is visible. */
export const IssuedTokenSchema = z.object({
  token: AgentTokenSchema,
  secret: z.string(),
})
export type IssuedToken = z.infer<typeof IssuedTokenSchema>
