import { z } from 'zod'
import { AiTaskSchema } from '../domain/admin'
import { AgentRoleSchema } from '../domain/agents'
import { AccountCodeSchema, ModelCodeSchema } from '../domain/common'
import { TagGroupSchema } from '../domain/markup'
import { PlatformSchema } from '../domain/model'
import { RoleSchema, UiSkinSchema } from '../domain/people'
import { ContractorFormatSchema } from '../domain/promo'

/** Commands of the owner's settings (DESIGN §4.19–4.21); forms check the same schemas. */

const LoginSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9._-]{1,31}$/, 'Латиница, цифры, точка; с буквы')

export const AddPersonCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя'),
  login: LoginSchema,
  role: RoleSchema,
  models: z.array(ModelCodeSchema),
})
export type AddPersonCommand = z.infer<typeof AddPersonCommandSchema>

export const UpdatePersonCommandSchema = z.object({
  role: RoleSchema.optional(),
  models: z.array(ModelCodeSchema).optional(),
})
export type UpdatePersonCommand = z.infer<typeof UpdatePersonCommandSchema>

/** «Добавить агента»: имя, роль, модели (Fyper — агент с ролью «Только чтение»). */
export const AddAgentCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя'),
  role: AgentRoleSchema,
  models: z.array(ModelCodeSchema),
})
export type AddAgentCommand = z.infer<typeof AddAgentCommandSchema>

export const UpdateAgentCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя').optional(),
  role: AgentRoleSchema.optional(),
  models: z.array(ModelCodeSchema).optional(),
})
export type UpdateAgentCommand = z.infer<typeof UpdateAgentCommandSchema>

export const AddModelCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя'),
  code: ModelCodeSchema,
})
export type AddModelCommand = z.infer<typeof AddModelCommandSchema>

export const AddAccountCommandSchema = z.object({
  platform: PlatformSchema,
  label: z.string().trim().min(1, 'Нужно название: «Fansly 4»'),
  code: AccountCodeSchema,
  handle: z.string().trim().min(1, 'Нужен ник на платформе'),
  hub_page: z.string().trim().min(1).nullable(),
})
export type AddAccountCommand = z.infer<typeof AddAccountCommandSchema>

/** «Добавить подрядчика»: a recipient of promo handoffs in the context of one model. */
export const AddContractorCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя'),
  /** Code of the promo channel; `null` — any. */
  channel: z.string().nullable(),
  contact: z.string().trim().nullable(),
  format: ContractorFormatSchema,
})
export type AddContractorCommand = z.infer<typeof AddContractorCommandSchema>

export const UpdateContractorCommandSchema = z.object({ format: ContractorFormatSchema })
export type UpdateContractorCommand = z.infer<typeof UpdateContractorCommandSchema>

/** `ru: null` clears the Russian name, `group: null` makes the tag free. */
export const UpdateTagCommandSchema = z.object({
  ru: z.string().trim().min(1).nullable().optional(),
  group: TagGroupSchema.nullable().optional(),
})
export type UpdateTagCommand = z.infer<typeof UpdateTagCommandSchema>

/** «Слить с…»: the tag disappears, its objects get `into`. */
export const MergeTagCommandSchema = z.object({ into: z.string().min(1) })
export type MergeTagCommand = z.infer<typeof MergeTagCommandSchema>

export const PauseQueueCommandSchema = z.object({ paused: z.boolean() })
export type PauseQueueCommand = z.infer<typeof PauseQueueCommandSchema>

/** «Настроить»: Hub gets the page code, Fyper gets its access key. */
export const ConnectIntegrationCommandSchema = z.object({
  hub_page: z.string().trim().min(1, 'Нужен код страницы в Hub').optional(),
  key: z.string().trim().min(1, 'Нужен ключ').optional(),
})
export type ConnectIntegrationCommand = z.infer<typeof ConnectIntegrationCommandSchema>

export const SignInCommandSchema = z.object({
  login: z.string().trim().min(1, 'Введите логин'),
  password: z.string().min(1, 'Введите пароль'),
})
export type SignInCommand = z.infer<typeof SignInCommandSchema>

/** Name, skin or both; the rest stays. */
export const UpdateProfileCommandSchema = z
  .object({
    name: z.string().trim().min(1, 'Нужно имя').optional(),
    ui_skin: UiSkinSchema.optional(),
  })
  .refine((change) => change.name !== undefined || change.ui_skin !== undefined, {
    message: 'Нечего менять',
  })
export type UpdateProfileCommand = z.infer<typeof UpdateProfileCommandSchema>

export const ChangePasswordCommandSchema = z.object({
  current: z.string().min(1, 'Введите нынешний пароль'),
  next: z.string().min(8, 'Не короче 8 знаков'),
})
export type ChangePasswordCommand = z.infer<typeof ChangePasswordCommandSchema>

export const AddAiServiceCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно название'),
  tasks: z.array(AiTaskSchema).min(1, 'Выберите, что сервис делает'),
  consent: z.literal(true, { error: 'Без согласия сервис ничего не получит' }),
})
export type AddAiServiceCommand = z.infer<typeof AddAiServiceCommandSchema>

export const UpdateAiServiceCommandSchema = z.object({ consent: z.boolean() })
export type UpdateAiServiceCommand = z.infer<typeof UpdateAiServiceCommandSchema>

export const UpdateAiBudgetCommandSchema = z.object({
  budget_month_usd: z.number().positive().nullable(),
})
export type UpdateAiBudgetCommand = z.infer<typeof UpdateAiBudgetCommandSchema>
