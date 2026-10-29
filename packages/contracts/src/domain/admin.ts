import { z } from 'zod'
import { InstantSchema } from './common'
import { PersonSchema } from './people'

/**
 * Records of the owner's settings that have no place of their own in the catalog:
 * the history of access rights, sessions, sign-in and the AI service (DESIGN §4.19–4.21).
 */

/** One line of «история выдачи прав»: «10.09 · Дмитрий добавил Lily». */
export const AccessGrantSchema = z.object({
  at: InstantSchema,
  by: z.string(),
  text: z.string(),
})
export type AccessGrant = z.infer<typeof AccessGrantSchema>

/** A session of the signed-in person (Настройки › Профиль и сессии). */
export const SessionSchema = z.object({
  id: z.string(),
  /** «Chrome на Mac». */
  device: z.string(),
  last_seen_at: InstantSchema,
  /** The browser the list is looked at from. */
  current: z.boolean(),
})
export type Session = z.infer<typeof SessionSchema>

/** «Добавить человека»: the temporary password is shown once and never again. */
export const PersonCreatedSchema = z.object({
  person: PersonSchema,
  temporary_password: z.string(),
})
export type PersonCreated = z.infer<typeof PersonCreatedSchema>

export const SignInResultSchema = z.object({ person: PersonSchema })
export type SignInResult = z.infer<typeof SignInResultSchema>

/** What an AI service is allowed to do (DESIGN §4.20). */
export const AiTaskSchema = z.enum(['markup', 'timeline', 'texts', 'frames'])
export type AiTask = z.infer<typeof AiTaskSchema>

export const AI_TASK_LABEL: Record<AiTask, string> = {
  markup: 'название, теги, описание',
  timeline: 'хронология',
  texts: 'тексты для платформы',
  frames: 'проверка кадров',
}

/** Consent of the owner to send frames and descriptions to one service. */
export const AiConsentSchema = z.object({ by: z.string(), at: InstantSchema })
export type AiConsent = z.infer<typeof AiConsentSchema>

export const AiServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  tasks: z.array(AiTaskSchema).min(1),
  /** Without consent the service gets nothing. */
  consent: AiConsentSchema.nullable(),
  spent_month_usd: z.number().nonnegative(),
})
export type AiService = z.infer<typeof AiServiceSchema>

/** `GET /api/v1/admin/ai`: empty until the first service is connected. */
export const AiSettingsSchema = z.object({
  services: z.array(AiServiceSchema),
  /** `null` — no monthly limit set. */
  budget_month_usd: z.number().positive().nullable(),
  spent_month_usd: z.number().nonnegative(),
  /** Stopped by the system: «много отказов (22 % на 30 объектах)». */
  stopped: z.object({ reason: z.string(), since: InstantSchema }).nullable(),
})
export type AiSettings = z.infer<typeof AiSettingsSchema>
