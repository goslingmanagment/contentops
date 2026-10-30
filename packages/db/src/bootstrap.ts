import { randomUUID } from 'node:crypto'
import { hash } from '@node-rs/argon2'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import * as t from '../drizzle/schema.ts'
import { type Db, logAction, SYSTEM_ACTOR, type Tx, withActorTx } from './client.ts'
import {
  contentTypes,
  genders,
  platforms,
  reservedModelCodes,
  surfaceKinds,
  uniqLevels,
} from './values.ts'

const code = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes')
const text = z.string().trim().min(1)

const SurfaceSchema = z.strictObject({
  kind: z.enum(surfaceKinds),
  /** Hub matches it automatically; only wall, FYP and vault may (schema §3.1). */
  auto_match: z.boolean(),
})

/** Surfaces of a page when the configuration names none: FYP exists only on Fansly. */
export const DEFAULT_SURFACES: Record<(typeof platforms)[number], z.infer<typeof SurfaceSchema>[]> =
  {
    fansly: [
      { kind: 'wall', auto_match: true },
      { kind: 'fyp', auto_match: true },
      { kind: 'story', auto_match: false },
      { kind: 'vault', auto_match: true },
      { kind: 'mass_dm', auto_match: false },
    ],
    onlyfans: [
      { kind: 'wall', auto_match: true },
      { kind: 'story', auto_match: false },
      { kind: 'vault', auto_match: true },
      { kind: 'mass_dm', auto_match: false },
    ],
  }

const AccountSchema = z
  .strictObject({
    code,
    platform: z.enum(platforms),
    title: text,
    handle: text,
    /** Page reference rows of Hub arrive by; `null` — Hub not configured. */
    hub_page_ref: text.nullable().default(null),
    default_uniq_level: z.enum(uniqLevels).nullable().default(null),
    surfaces: z.array(SurfaceSchema).min(1).optional(),
  })
  .transform((account) => ({
    ...account,
    surfaces: account.surfaces ?? DEFAULT_SURFACES[account.platform],
  }))

const CounterSchema = z.strictObject({
  /** First number the counter issues. */
  next_number: z.int().min(1),
  /**
   * The type has legacy numbers: acceptance waits for the legacy pass of stage 3
   * (`legacy_reserved_at` stays empty). Without legacy bootstrap marks it reserved.
   */
  legacy: z.boolean(),
})

const ModelSchema = z.strictObject({
  code: code.refine(
    (value) => !(reservedModelCodes as readonly string[]).includes(value),
    'reserved model code',
  ),
  title: text,
  title_genitive: text,
  timezone: z
    .string()
    .default('Europe/Moscow')
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone })
        return true
      } catch {
        return false
      }
    }, 'unknown time zone'),
  accounts: z.array(AccountSchema),
  promo_channels: z.array(z.strictObject({ code, title: text })).default([]),
  /** Every type is listed: a forgotten legacy flag would issue numbers twice. */
  id_counters: z.record(z.enum(contentTypes), CounterSchema),
})

export const BootstrapConfigSchema = z
  .strictObject({
    models: z.array(ModelSchema).min(1),
    owner: z.strictObject({
      login: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
      display_name: text,
      gender: z.enum(genders),
      /** Environment variable with the first password; read only when the owner is new. */
      password_env: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]*$/)
        .default('CONTENTOPS_OWNER_PASSWORD'),
    }),
  })
  .superRefine((config, ctx) => {
    const repeated = (values: string[]) => values.filter((v, i) => values.indexOf(v) !== i)
    const issues = [
      ...repeated(config.models.map((m) => m.code)).map((c) => `model ${c} twice`),
      ...repeated(config.models.flatMap((m) => m.accounts.map((a) => a.code))).map(
        (c) => `account ${c} twice`,
      ),
      ...repeated(
        config.models.flatMap((m) =>
          m.accounts.flatMap((a) => (a.hub_page_ref ? [a.hub_page_ref] : [])),
        ),
      ).map((ref) => `hub_page_ref ${ref} twice`),
      ...config.models.flatMap((m) =>
        repeated(m.promo_channels.map((p) => p.code)).map((c) => `${m.code}: channel ${c} twice`),
      ),
      ...config.models.flatMap((m) =>
        m.accounts.flatMap((a) => [
          ...repeated(a.surfaces.map((s) => s.kind)).map((k) => `${a.code}: surface ${k} twice`),
          ...a.surfaces
            .filter((s) => s.auto_match && !['wall', 'fyp', 'vault'].includes(s.kind))
            .map((s) => `${a.code}: ${s.kind} cannot be matched automatically`),
        ]),
      ),
    ]
    for (const message of issues) ctx.addIssue({ code: 'custom', message })
  })

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>

export interface BootstrapOptions {
  /** Where the owner's password variable is read; default `process.env`. */
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}

export interface BootstrapResult {
  /** What this run created: `model lora`, `account lora-1`, `surface lora-1/wall`, … */
  created: string[]
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootstrapError'
  }
}

/** Serialises concurrent bootstrap runs ("co-boot"). */
const BOOTSTRAP_LOCK_KEY = 0x636f_626f_6f74

/**
 * Creates what the configuration names and the database lacks: models, pages, surfaces,
 * promo channels, ID counters and the first owner with grants on every model.
 * Existing rows are never changed, so a second run changes nothing. Writes as `system`.
 */
export async function bootstrap(
  db: Db,
  input: unknown,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const config = BootstrapConfigSchema.parse(input)
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const context = { actor: SYSTEM_ACTOR('bootstrap'), action: 'bootstrap', requestId: randomUUID() }

  const created = await withActorTx(db, context, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`)
    const created: string[] = []
    const ownerId = await ensureOwner(tx, config.owner, env, created)
    for (const model of config.models) {
      const modelId = await ensureModel(tx, model, created)
      await ensureAccounts(tx, modelId, model, created)
      await ensurePromoChannels(tx, modelId, model, created)
      await ensureCounters(tx, modelId, model, created)
      await ensureGrant(tx, modelId, model.code, ownerId, config.owner.login, created)
    }
    if (created.length > 0) {
      await logAction(tx, {
        modelId: null,
        subjectKind: 'bootstrap',
        subjectLabel: 'bootstrap',
        after: { created },
      })
    }
    return created
  })

  if (created.length === 0) log('bootstrap: nothing to do, everything is in place')
  for (const line of created) log(`bootstrap: created ${line}`)
  return { created }
}

async function ensureOwner(
  tx: Tx,
  owner: BootstrapConfig['owner'],
  env: Record<string, string | undefined>,
  created: string[],
): Promise<string> {
  const [existing] = await tx
    .select({ id: t.principals.id, role: t.principals.role })
    .from(t.principals)
    .where(eq(t.principals.login, owner.login))
  if (existing) {
    if (existing.role !== 'owner') {
      throw new BootstrapError(`principal ${owner.login} exists and is not an owner`)
    }
    return existing.id
  }
  const password = env[owner.password_env]
  if (!password || password.length < 8) {
    throw new BootstrapError(
      `set ${owner.password_env} (at least 8 characters): the first owner needs a password`,
    )
  }
  const [row] = await tx
    .insert(t.principals)
    .values({
      kind: 'human',
      login: owner.login,
      displayName: owner.display_name,
      gender: owner.gender,
      role: 'owner',
      passwordHash: await hash(password),
    })
    .returning({ id: t.principals.id })
  if (!row) throw new BootstrapError('owner insert returned nothing')
  // Principals have no journal trigger: the administration event is typed, without secrets.
  await logAction(tx, {
    modelId: null,
    action: 'principal.create',
    subjectKind: 'principals',
    subjectId: row.id,
    subjectLabel: owner.login,
    after: { login: owner.login, display_name: owner.display_name, role: 'owner' },
  })
  created.push(`owner ${owner.login}`)
  return row.id
}

type ModelConfig = BootstrapConfig['models'][number]

async function ensureModel(tx: Tx, model: ModelConfig, created: string[]): Promise<string> {
  const [row] = await tx
    .insert(t.models)
    .values({
      code: model.code,
      title: model.title,
      titleGenitive: model.title_genitive,
      timezone: model.timezone,
    })
    .onConflictDoNothing({ target: t.models.code })
    .returning({ id: t.models.id })
  if (row) {
    created.push(`model ${model.code}`)
    return row.id
  }
  const [existing] = await tx
    .select({ id: t.models.id })
    .from(t.models)
    .where(eq(t.models.code, model.code))
  if (!existing) throw new BootstrapError(`model ${model.code} vanished`)
  return existing.id
}

async function ensureAccounts(tx: Tx, modelId: string, model: ModelConfig, created: string[]) {
  for (const [position, account] of model.accounts.entries()) {
    const [existing] = await tx
      .select({ id: t.accounts.id, modelId: t.accounts.modelId })
      .from(t.accounts)
      .where(eq(t.accounts.code, account.code))
    let accountId = existing?.id
    if (existing && existing.modelId !== modelId) {
      throw new BootstrapError(`account ${account.code} belongs to another model`)
    }
    if (!accountId) {
      const [row] = await tx
        .insert(t.accounts)
        .values({
          modelId,
          code: account.code,
          platform: account.platform,
          title: account.title,
          handle: account.handle,
          position: position + 1,
          hubPageRef: account.hub_page_ref,
          defaultUniqLevel: account.default_uniq_level,
        })
        .returning({ id: t.accounts.id })
      if (!row) throw new BootstrapError(`account ${account.code} insert returned nothing`)
      accountId = row.id
      created.push(`account ${account.code}`)
    }
    for (const surface of account.surfaces) {
      const [row] = await tx
        .insert(t.surfaces)
        .values({ modelId, accountId, kind: surface.kind, autoMatch: surface.auto_match })
        .onConflictDoNothing({ target: [t.surfaces.accountId, t.surfaces.kind] })
        .returning({ id: t.surfaces.id })
      if (row) created.push(`surface ${account.code}/${surface.kind}`)
    }
  }
}

async function ensurePromoChannels(tx: Tx, modelId: string, model: ModelConfig, created: string[]) {
  for (const channel of model.promo_channels) {
    const [row] = await tx
      .insert(t.promoChannels)
      .values({ modelId, code: channel.code, title: channel.title })
      .onConflictDoNothing({ target: [t.promoChannels.modelId, t.promoChannels.code] })
      .returning({ id: t.promoChannels.id })
    if (row) created.push(`promo channel ${model.code}/${channel.code}`)
  }
}

async function ensureCounters(tx: Tx, modelId: string, model: ModelConfig, created: string[]) {
  for (const type of contentTypes) {
    const counter = model.id_counters[type]
    const [row] = await tx
      .insert(t.idCounters)
      .values({
        modelId,
        type,
        nextNumber: counter.next_number,
        legacyReservedAt: counter.legacy ? null : sql`now()`,
      })
      .onConflictDoNothing({ target: [t.idCounters.modelId, t.idCounters.type] })
      .returning({ type: t.idCounters.type })
    if (row) created.push(`counter ${model.code}/${type}`)
  }
}

async function ensureGrant(
  tx: Tx,
  modelId: string,
  modelCode: string,
  ownerId: string,
  ownerLogin: string,
  created: string[],
) {
  const [live] = await tx
    .select({ id: t.principalGrants.id })
    .from(t.principalGrants)
    .where(
      and(
        eq(t.principalGrants.principalId, ownerId),
        eq(t.principalGrants.modelId, modelId),
        isNull(t.principalGrants.revokedAt),
      ),
    )
  if (live) return
  await tx.insert(t.principalGrants).values({ modelId, principalId: ownerId })
  created.push(`grant ${ownerLogin} → ${modelCode}`)
}
