import { type Queryable, values } from '@contentops/db'
import { AGGREGATE_FIELDS, type MarkupType, type ProviderName } from '@contentops/vision'
import { sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Settings of the cloud markup (SPEC §8, §8.3; schema §3.1, §9.8): rows of `policy_settings`
 * that only the owner writes, nothing set means off. Keys and addresses of the providers live
 * in the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), never here.
 *
 * - `annotation.enabled` — the markup of a model (or of all) by its routes; a `false` anywhere
 *   wins. `annotation.texts` — the selling texts on top of it (SPEC §8 «отдельно тексты»).
 * - `annotation.route.<TYPE>.<stage>` — who marks up this type at this stage: a provider and
 *   at most one independent spare, the fields asked, the frames, a cap of the route. Global or
 *   of a model (the model's wins).
 * - `annotation.external.<provider>` — the owner's consent: who, when, which types, stages and
 *   frames may go there, the storage setting of the account, the prices of its models.
 * - `annotation.budget` — the money of a window: nothing is sent without it.
 * - `annotation.limit.<provider>` — a provider's share of that window.
 * - `annotation.resumed.<provider>` — «Включить» after a stop (a refused key, the breaker).
 */

export const MARKUP_TYPES = ['PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW'] as const

const Instant = z.iso.datetime({ offset: true })
const Provider = z.enum(values.annotationProviders)
const Stage = z.enum(values.annotationStages)
const Type = z.enum(MARKUP_TYPES)

export const ConsentSchema = z.strictObject({
  by: z.string().trim().min(1),
  at: Instant,
  types: z.array(Type).min(1),
  stages: z.array(Stage).min(1),
  /** Frames may go there (the `observe` stage); without it — text stages only. */
  frames: z.boolean(),
  /** The storage setting of the account in words: «store=false; 30 дней на проверку злоупотреблений». */
  privacy: z.string().trim().min(1),
  /** US dollars per million tokens of the provider's models, for the reserve. */
  prices: z
    .record(
      z.string().min(1),
      z.strictObject({ input: z.number().positive(), output: z.number().positive() }),
    )
    .default({}),
})
export type Consent = z.infer<typeof ConsentSchema>

export const RouteProviderSchema = z.strictObject({
  provider: Provider,
  model: z.string().trim().min(1),
  /** The provider's effort or reasoning level; its default when omitted. */
  effort: z.string().trim().min(1).optional(),
})
export type RouteProvider = z.infer<typeof RouteProviderSchema>

export const RouteSchema = z.strictObject({
  providers: z
    .array(RouteProviderSchema)
    .min(1)
    .max(2)
    .refine((list) => new Set(list.map((entry) => entry.provider)).size === list.length, {
      message: 'запасной поставщик — другой поставщик',
    }),
  /** The fields of `aggregate` asked for; all of them when omitted. */
  fields: z.array(z.enum(AGGREGATE_FIELDS)).min(1).optional(),
  /** At most this many frames per request; 48 when omitted. */
  frames: z.int().min(1).max(100).optional(),
  /** This route's cap within the budget's window, US dollars. */
  max_usd: z.number().positive().optional(),
})
export type Route = z.infer<typeof RouteSchema>

export const BudgetSchema = z.strictObject({ usd: z.number().positive(), since: Instant })
export type Budget = z.infer<typeof BudgetSchema>

export const LimitSchema = z.strictObject({ usd: z.number().positive() })
export const ResumedSchema = z.strictObject({ at: Instant })

export const DEFAULT_FRAMES = 48

export const annotationKey = {
  enabled: 'annotation.enabled',
  texts: 'annotation.texts',
  budget: 'annotation.budget',
  consent: (provider: ProviderName) => `annotation.external.${provider}`,
  limit: (provider: ProviderName) => `annotation.limit.${provider}`,
  resumed: (provider: ProviderName) => `annotation.resumed.${provider}`,
  route: (type: MarkupType, stage: values.AnnotationStage) => `annotation.route.${type}.${stage}`,
  /** Only a reason of a pause: the key of a provider is not in the environment. */
  key: (provider: ProviderName) => `annotation.key.${provider}`,
} as const

/** The schema of a key's value; `null` for a switch (`true` / `false`) and unknown keys. */
export function schemaOfKey(key: string): z.ZodType | null {
  if (key === annotationKey.budget) return BudgetSchema
  if (/^annotation\.external\.[a-z]+$/.test(key)) return ConsentSchema
  if (/^annotation\.limit\.[a-z]+$/.test(key)) return LimitSchema
  if (/^annotation\.resumed\.[a-z]+$/.test(key)) return ResumedSchema
  if (/^annotation\.route\.[A-Z]+\.[a-z]+$/.test(key)) return RouteSchema
  return null
}

export interface AnnotationSettings {
  enabled: boolean
  texts: boolean
  budget: Budget | null
  consents: Map<ProviderName, Consent>
  limits: Map<ProviderName, number>
  resumed: Map<ProviderName, string>
  /** By `<TYPE>.<stage>`. */
  routes: Map<string, Route>
}

interface Row extends Record<string, unknown> {
  key: string
  model_id: string | null
  value: unknown
}

/** On only where some level says `true` and none says `false` (the rule of `isSwitchOn`). */
function switchOf(rows: readonly Row[], key: string): boolean {
  const levels = rows.filter((row) => row.key === key)
  return levels.some((row) => row.value === true) && !levels.some((row) => row.value === false)
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value)
  return result.success ? result.data : null
}

/**
 * The settings in force for a model's objects. A value that does not pass its schema counts as
 * not set: written by hand past `ops.js`, it switches its function off rather than on.
 */
export async function annotationSettings(
  q: Queryable,
  modelId: string,
): Promise<AnnotationSettings> {
  const { rows } = await q.execute<Row>(sql`
    SELECT key, model_id, value FROM policy_settings
     WHERE key LIKE 'annotation.%' AND account_id IS NULL AND item_type IS NULL
       AND (model_id IS NULL OR model_id = ${modelId}::uuid) AND value IS NOT NULL`)
  const global = rows.filter((row) => row.model_id === null)
  const settings: AnnotationSettings = {
    enabled: switchOf(rows, annotationKey.enabled),
    texts: switchOf(rows, annotationKey.texts),
    budget: null,
    consents: new Map(),
    limits: new Map(),
    resumed: new Map(),
    routes: new Map(),
  }
  for (const row of global) {
    if (row.key === annotationKey.budget) settings.budget = parsed(BudgetSchema, row.value)
  }
  for (const provider of values.annotationProviders) {
    const of = (key: string) => global.find((row) => row.key === key)?.value
    const consent = parsed(ConsentSchema, of(annotationKey.consent(provider)))
    if (consent) settings.consents.set(provider, consent)
    const limit = parsed(LimitSchema, of(annotationKey.limit(provider)))
    if (limit) settings.limits.set(provider, limit.usd)
    const resumed = parsed(ResumedSchema, of(annotationKey.resumed(provider)))
    if (resumed) settings.resumed.set(provider, resumed.at)
  }
  for (const type of MARKUP_TYPES) {
    for (const stage of values.annotationStages) {
      const key = annotationKey.route(type, stage)
      const own = rows.find((row) => row.key === key && row.model_id === modelId)
      const route =
        parsed(RouteSchema, own?.value) ??
        parsed(RouteSchema, global.find((row) => row.key === key)?.value)
      if (route) settings.routes.set(`${type}.${stage}`, route)
    }
  }
  return settings
}
