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
  /** Pilot thresholds of free space: warning and stop of intake (SPEC §12.2). */
  SPACE_WARN_GB: z.coerce.number().nonnegative().default(200),
  SPACE_STOP_GB: z.coerce.number().nonnegative().default(100),
  /** Who may set `X-Forwarded-*` and `X-Request-Id`: `loopback`, addresses or CIDRs. */
  TRUSTED_PROXY: commaList(z.string()).default(['loopback']),

  YDISK_TOKEN: z.string().optional(),
  DROPBOX_TOKEN: z.string().optional(),
  HUB_BASE_URL: z.url().optional(),
  HUB_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
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
