import { z } from 'zod'
import { AiTaskSchema } from '../domain/admin'
import { AccountCodeSchema, ModelCodeSchema } from '../domain/common'
import { TagGroupSchema } from '../domain/markup'
import { PlatformSchema } from '../domain/model'
import { RoleSchema } from '../domain/people'
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

export const UpdateProfileCommandSchema = z.object({
  name: z.string().trim().min(1, 'Нужно имя'),
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
