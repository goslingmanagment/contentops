import { isAbsolute } from 'node:path'
import { z } from 'zod'

/**
 * Configuration comes only from the environment (SPEC §12.1): no host names, addresses or
 * host paths in code. Secrets of integrations are optional: the app starts without the
 * secrets of disabled integrations (SPEC §8).
 */

export const ROLES = ['web', 'migrate', 'worker', 'worker-video', 'worker-image'] as const
export type ProcessRole = (typeof ROLES)[number]

const AbsolutePath = z.string().refine(isAbsolute, 'нужен абсолютный путь')
const Count = z.coerce.number().int().positive()

/** A threshold of free space: the value of every disk, and of some disks their own. */
export interface DiskGb {
  all: number
  disks: Record<string, number>
}

/** The pilot's thresholds when the environment says nothing (SPEC §12.2). */
export const PILOT_SPACE_GB: { warn: DiskGb; stop: DiskGb } = {
  warn: { all: 200, disks: { 'E:': 160 } },
  stop: { all: 100, disks: {} },
}

/**
 * `200` — every disk; `200,E:=160` — 200, and E: its own 160. A disk not named takes the value
 * without a name (SPEC §12.2: the budgets of each disk decide its warning).
 */
const DiskGbSchema = z.string().transform((value, ctx): DiskGb => {
  const out: DiskGb = { all: Number.NaN, disks: {} }
  for (const part of value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [name, gb] = part.includes('=') ? part.split('=', 2) : [null, part]
    const number = Number(gb)
    if (gb === undefined || gb.trim() === '' || !Number.isFinite(number) || number < 0) {
      ctx.addIssue({ code: 'custom', message: 'ожидается «200» или «200,E:=160»' })
      return z.NEVER
    }
    if (name === null) out.all = number
    else out.disks[name.trim()] = number
  }
  if (Number.isNaN(out.all)) {
    ctx.addIssue({ code: 'custom', message: 'нужно значение для всех дисков: «200,E:=160»' })
    return z.NEVER
  }
  return out
})

/** `a,b,c` with spaces and empty items dropped. */
function commaList(item: z.ZodType<string, string>) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    )
    .pipe(z.array(item))
}

const EnvSchema = z.object({
  ROLE: z.enum(ROLES).default('web'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Owner of the schema: only the one-shot `migrate` role connects with it. */
  MIGRATE_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),

  DATA_ROOT: AbsolutePath.optional(),
  DERIVED_ROOT: AbsolutePath.optional(),
  TMP_ROOT: AbsolutePath.optional(),
  BACKUP_ROOT: AbsolutePath.optional(),
  LEGACY_SOURCE_ROOT: AbsolutePath.optional(),
  /**
   * The Windows list of the local Я.Диск copy (`ops/winpc/ydisk-copy-list.ps1`, SPEC §12.2):
   * the import reads the copy only where it says the bytes are there.
   */
  LEGACY_COPY_LIST: AbsolutePath.optional(),
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),

  FETCH_JOBS: Count.default(4),
  ENCODE_JOBS: Count.default(1),
  COPY_JOBS: Count.default(1),
  IMAGE_JOBS: Count.default(2),
  SVTAV1_LP: Count.default(4),
  FETCH_AHEAD_GB: z.coerce.number().positive().default(25),

  /** Each path must be a mount point, or `/healthz` is red (SPEC §12.2: disk E: in the VM). */
  REQUIRE_MOUNTS: commaList(AbsolutePath).default([]),
  /**
   * Each path must carry the volume mark that `ops/up.sh` leaves after `mountpoint -q` on the
   * host: inside a container a bind mount always looks mounted. Without it `/healthz` is red
   * and the workers wait (SPEC §12.2: while disk E: is not mounted the workers do not start).
   */
  REQUIRE_VOLUMES: commaList(AbsolutePath).default([]),
  /** Migrations of `packages/db`; the image sets it, the bundle cannot find them itself. */
  MIGRATIONS_DIR: AbsolutePath.optional(),
  /**
   * Free space of the host disks (SPEC §12.2: on the pilot the truth is in Windows, the VM
   * disks grow): JSON written by the host every 5 min. Without it the space is «нет данных».
   */
  HOST_SPACE_FILE: AbsolutePath.optional(),
  /**
   * Pilot thresholds of free space by disk (SPEC §12.2): the warning — C: 200 (the owner's
   * decision), E: 160 (the stop and the scratch above it: derived files and the prefetch live
   * there); the stop of intake — 100 on every disk.
   */
  SPACE_WARN_GB: DiskGbSchema.default(PILOT_SPACE_GB.warn),
  SPACE_STOP_GB: DiskGbSchema.default(PILOT_SPACE_GB.stop),
  /**
   * Development without nginx: `web` streams files itself instead of `X-Accel-Redirect`.
   * Never set in the stack: nginx sends the bytes (SPEC §12.0 «отдача»).
   */
  FILES_DIRECT: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
  /** Who may set `X-Forwarded-*` and `X-Request-Id`: `loopback`, addresses or CIDRs. */
  TRUSTED_PROXY: commaList(z.string()).default(['loopback']),

  /**
   * Tokens of the cloud sources are read by the name in `sources.credentials_ref` (SPEC §8):
   * `YDISK_TOKEN`, `DROPBOX_REFRESH_TOKEN` with `DROPBOX_APP_KEY` (+ `DROPBOX_APP_SECRET`).
   */
  YDISK_TOKEN: z.string().optional(),
  DROPBOX_REFRESH_TOKEN: z.string().optional(),
  DROPBOX_APP_KEY: z.string().optional(),
  DROPBOX_APP_SECRET: z.string().optional(),
  HUB_BASE_URL: z.url().optional(),
  HUB_API_KEY: z.string().optional(),
  /**
   * «Войти через хаб» (SPEC §11.1): the address of ContentOps where the sign-in screen offers
   * it — the public name, whose `/auth/hub/callback` Hub knows for `HUB_SIGNIN_CLIENT`. Other
   * names (the VPN, the tailnet) keep the password only. Empty — no hub sign-in anywhere.
   * The browser goes to Hub's console at `HUB_BASE_URL`, and the code is redeemed there.
   */
  HUB_SIGNIN_ORIGIN: z.url({ protocol: /^https?$/ }).optional(),
  /** The client's name at Hub (its capability is `signin:<name>`). */
  HUB_SIGNIN_CLIENT: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .default('contentops'),
  /** A Hub agent key with `signin:<client>`; empty — `HUB_API_KEY` carries it. */
  HUB_SIGNIN_KEY: z.string().optional(),
  /**
   * ContentOps' own Hub key with `introspect:agent_keys` (SPEC §11.1, ecosystem M2): with it and
   * `HUB_BASE_URL` an agent may call with its Agency Hub key, acting as the local agent linked to
   * its code (`ops.js hub-agent`). Empty — hub keys are not accepted, nothing else changes.
   */
  HUB_INTROSPECT_KEY: z.string().optional(),
  /**
   * Login of the ContentOps owner whom Hub's owner signs in as: linked at the first sign-in
   * through the hub (`principals.hub_user_id`). Nobody else is linked by configuration.
   */
  HUB_SIGNIN_OWNER: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * Addresses of the markup providers when not their own (`https://api.openai.com/v1`, the
   * Anthropic SDK's default): the fake providers of `DEV_FAKE_AI=1 pnpm dev:server`.
   */
  OPENAI_BASE_URL: z.url().optional(),
  ANTHROPIC_BASE_URL: z.url().optional(),
})

export type Config = z.output<typeof EnvSchema>

type ConfigKey = keyof Config

const STORAGE: ConfigKey[] = ['DATA_ROOT', 'DERIVED_ROOT', 'TMP_ROOT']

/** What each role cannot start without. */
const REQUIRED_BY_ROLE: Record<ProcessRole, ConfigKey[]> = {
  web: ['DATABASE_URL', ...STORAGE, 'PUBLIC_URL'],
  migrate: ['MIGRATE_DATABASE_URL'],
  // No backup on the pilot (SPEC §12.3): BACKUP_ROOT comes with the server (PLAN 9б).
  worker: ['DATABASE_URL', ...STORAGE],
  'worker-video': ['DATABASE_URL', ...STORAGE],
  'worker-image': ['DATABASE_URL', ...STORAGE],
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Неверная конфигурация окружения:\n${problems.map((line) => `  ${line}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/** Parses the environment; throws `ConfigError` listing every problem, never the values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // `KEY=` in an env file means «not set».
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  )
  const parsed = EnvSchema.safeParse(present)
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    )
  }
  const config = parsed.data
  const missing = REQUIRED_BY_ROLE[config.ROLE].filter((key) => config[key] === undefined)
  if (missing.length > 0) {
    throw new ConfigError(missing.map((key) => `${key}: нужна для роли ${config.ROLE}`))
  }
  return config
}
