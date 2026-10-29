import { z } from 'zod'
import { AccountCodeSchema, InstantSchema, ModelCodeSchema } from './common'

export const IntegrationKindSchema = z.enum(['ydisk', 'hub', 'ai', 'fyper', 'telegram', 'agents'])
export type IntegrationKind = z.infer<typeof IntegrationKindSchema>

export const INTEGRATION_NAME: Record<IntegrationKind, string> = {
  ydisk: 'Я.Диск',
  hub: 'Hub',
  ai: 'Разметка ИИ',
  fyper: 'Fyper',
  telegram: 'Telegram',
  agents: 'Агенты',
}

/** Five states of any integration (DESIGN §3.11). */
export const IntegrationStateSchema = z.enum(['working', 'off', 'unset', 'down', 'catching_up'])
export type IntegrationState = z.infer<typeof IntegrationStateSchema>

export const IntegrationDownReasonSchema = z.enum(['unreachable', 'format_changed'])
export type IntegrationDownReason = z.infer<typeof IntegrationDownReasonSchema>

export const IntegrationSwitchesSchema = z.object({
  /** Hub: «Получать данные». */
  receive: z.boolean().optional(),
  /** Hub: «Автосверка». */
  auto_match: z.boolean().optional(),
  /** Я.Диск: «Скан по источнику». */
  scan: z.boolean().optional(),
  /** Агенты: работают все токены или никто. */
  enabled: z.boolean().optional(),
})
export type IntegrationSwitches = z.infer<typeof IntegrationSwitchesSchema>

export const IntegrationSchema = z.object({
  id: z.string(),
  kind: IntegrationKindSchema,
  /** `null` for integrations shared by all models (ИИ, Fyper). */
  model: ModelCodeSchema.nullable(),
  /** Set for Hub, which is switched per page. */
  account: AccountCodeSchema.nullable(),
  state: IntegrationStateSchema,
  last_ok_at: InstantSchema.nullable(),
  /** Since when it is off or down. */
  since: InstantSchema.nullable(),
  retry_at: InstantSchema.nullable(),
  down_reason: IntegrationDownReasonSchema.nullable(),
  catch_up: z.object({ done_hours: z.number(), total_hours: z.number() }).nullable(),
  switches: IntegrationSwitchesSchema,
})
export type Integration = z.infer<typeof IntegrationSchema>

export const IntegrationIconSchema = z.enum([
  'dot',
  'power-off',
  'key-round',
  'cloud-off',
  'refresh-cw',
])
export type IntegrationIcon = z.infer<typeof IntegrationIconSchema>

/** One line `IntegrationLine`: icon + name + phrase + an owner-only button. */
export const IntegrationLineSchema = z.object({
  integration_id: z.string(),
  state: IntegrationStateSchema,
  icon: IntegrationIconSchema,
  tone: z.enum(['muted', 'attention']),
  text: z.string(),
  owner_action: z.enum(['Включить', 'Настроить', 'Подробнее']).nullable(),
})
export type IntegrationLine = z.infer<typeof IntegrationLineSchema>
