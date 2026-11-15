import { z } from 'zod'
import { GenderSchema, InstantSchema, ModelCodeSchema, RecordVersionSchema } from './common'
import { PlatformSchema } from './model'

/**
 * Roles (SPEC §11.1); rights are a role plus a list of models. «Только кастомы» (`customs`) is a person
 * who leads customs in Hub: the custom orders and «Ждут вас» of their models, nothing else (products
 * plan §2.4); Hub gives it, nobody sets it here.
 */
export const RoleSchema = z.enum(['owner', 'manager', 'reader', 'customs'])
export type Role = z.infer<typeof RoleSchema>

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец',
  manager: 'Контент-менеджер',
  reader: 'Только чтение',
  customs: 'Только кастомы',
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
  /** The person came from Hub (its code there): the role and the models are Hub's, not edited here. */
  hub_code: z.string().nullable().optional(),
})
export type Person = z.infer<typeof PersonSchema>

/** Interface skin chosen by the person (DESIGN §7.10): blue by default, or «Фокус». */
export const UiSkinSchema = z.enum(['blue', 'focus'])
export type UiSkin = z.infer<typeof UiSkinSchema>

export const UI_SKIN_LABEL: Record<UiSkin, string> = { blue: 'синий', focus: 'Фокус' }

/** The principal behind the current session, with the models it may see and its skin. */
/**
 * One line of the products' switcher (products plan §2.1): the products Hub gives the person, as Hub's
 * `auth/me` names them; ContentOps is this one. Outside tools (Задачи, Монитор) are said quieter.
 */
export const ProductLinkSchema = z.object({
  id: z.enum(['hub', 'workboard', 'contentops', 'tasks', 'monitor']),
  label: z.string(),
  href: z.string(),
  current: z.boolean(),
  quiet: z.boolean(),
})
export type ProductLink = z.infer<typeof ProductLinkSchema>

export const SessionPrincipalSchema = z.object({
  person: PersonSchema,
  models: z.array(ModelCodeSchema),
  ui_skin: UiSkinSchema,
  /** The switcher: fewer than two products (a content manager), none is drawn. */
  products: z.array(ProductLinkSchema).optional(),
  /** «Первый день» on «Сегодня» is shown until the person closes it. */
  first_day: z.boolean().optional(),
})
export type SessionPrincipal = z.infer<typeof SessionPrincipalSchema>
