import { z } from 'zod'
import { AccountCodeSchema, ModelCodeSchema } from './common'

export const PlatformSchema = z.enum(['fansly', 'onlyfans'])
export type Platform = z.infer<typeof PlatformSchema>

/** How strongly FYP versions differ from the montage: «мягко», «подрезка», «зеркало». */
export const UniqLevelSchema = z.enum(['soft', 'trim', 'mirror'])
export type UniqLevel = z.infer<typeof UniqLevelSchema>

export const UNIQ_LEVEL_LABEL: Record<UniqLevel, string> = {
  soft: 'мягко',
  trim: 'подрезка',
  mirror: 'зеркало',
}

/** A page of a model on a platform (SPEC `accounts`): `lora-2`, «Fansly 2», LoraViex. */
export const AccountSchema = z.object({
  code: AccountCodeSchema,
  model: ModelCodeSchema,
  platform: PlatformSchema,
  label: z.string(),
  handle: z.string(),
  /** Page code in Agency Hub; `null` when Hub is not set up for the page. */
  hub_page: z.string().nullable(),
  usual_assignee: z.string().nullable(),
  uniq_level: UniqLevelSchema,
  position: z.int().nonnegative(),
})
export type Account = z.infer<typeof AccountSchema>

export const ModelSchema = z.object({
  code: ModelCodeSchema,
  name: z.string(),
  /** «от Лоры», «от Lily». */
  name_genitive: z.string(),
  timezone: z.literal('Europe/Moscow'),
  accounts: z.array(AccountSchema),
})
export type Model = z.infer<typeof ModelSchema>
