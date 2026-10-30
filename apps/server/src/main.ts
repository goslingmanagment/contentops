import { hostname } from 'node:os'
import {
  createDb,
  createPool,
  runMigrations,
  type values,
  type WorkHandler,
  WorkRunner,
  WorkScheduler,
} from '@contentops/db'
import type { Logger } from 'pino'
import { type Config, ConfigError, loadConfig } from './config'
import { isMountpoint, missingVolumes } from './health'
import { draftZipExport } from './intake/draft-files'
import { fetchHandler } from './intake/fetch'
import { intakeMediaHandlers } from './intake/media'
import { scanHandler, scanStreams } from './intake/scan'
import { envSourceFactory } from './intake/source-client'
import { startStagingSweep } from './intake/staging'
import { importParseHandler } from './legacy/parse'
import { createLogger } from './logger'
import { startGenerationCollector } from './media/collector'
import { createMediaEnv } from './media/pipeline'
import { imageThrottle, mediaHandlers, startExportSweep } from './media/roles'
import { BlobStore } from './media/storage'
import { reconcileStorage } from './media/storage-ops'
import { buildServer } from './server'
import { createWorkGate } from './work-gate'

type WorkRole = (typeof values.workRoles)[number]

function readConfig(): Config {
  try {
    return loadConfig()
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

/** Runs `stop` once on SIGTERM / SIGINT (`docker compose stop`), then exits. */
function onStop(logger: Logger, stop: () => Promise<void>): void {
  let stopping = false
  const handle = async (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'stopping')
    try {
      await stop()
      process.exit(0)
    } catch (error) {
      logger.error({ err: error }, 'stop failed')
      process.exit(1)
    }
  }
  process.once('SIGTERM', handle)
  process.once('SIGINT', handle)
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is not set`)
  return value
}

async function runWeb(config: Config, logger: Logger): Promise<void> {
  const pool = createPool(required(config.DATABASE_URL, 'DATABASE_URL'), {
    applicationName: 'web',
  })
  // `/healthz`: web answers, the database takes a query as the app role (SPEC §12.2), the
  // storage roots carry their volume marks.
  const db = createDb(pool)
  const storage = {
    dataRoot: required(config.DATA_ROOT, 'DATA_ROOT'),
    derivedRoot: required(config.DERIVED_ROOT, 'DERIVED_ROOT'),
    tmpRoot: required(config.TMP_ROOT, 'TMP_ROOT'),
  }
  const app = buildServer({
    db,
    publicUrl: required(config.PUBLIC_URL, 'PUBLIC_URL'),
    // The app starts without the secrets of switched-off integrations (SPEC §8).
    secrets: { hub: config.HUB_API_KEY !== undefined && config.HUB_BASE_URL !== undefined },
    space: {
      file: config.HOST_SPACE_FILE,
      warnGb: config.SPACE_WARN_GB,
      stopGb: config.SPACE_STOP_GB,
    },
    logger,
    trustedProxy: config.TRUSTED_PROXY,
    requireMounts: config.REQUIRE_MOUNTS,
    requireVolumes: config.REQUIRE_VOLUMES,
    storage,
    filesDirect: config.FILES_DIRECT,
  })
  app.addHook('onClose', () => pool.end())
  onStop(logger, () => app.close())
  await app.listen({ host: config.HOST, port: config.PORT })
  // Web uploads register their bytes as blobs (`intake/upload.ts`): what a crash left half
  // done is settled against the disk, as the worker roles do it — only with the disks mounted.
  if ((await missingStorage(config)).length === 0) {
    reconcileStorage(db, new BlobStore(storage), 'web:').then(
      (reconciled) => logger.info({ ...reconciled }, 'storage operations reconciled'),
      (error: unknown) => logger.error({ err: error }, 'storage operations not reconciled'),
    )
  }
}

/** The database is not there yet: its name, its port or its startup (SQLSTATE 57P03). */
const NOT_UP_YET = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', '57P03'])
const MIGRATE_WAIT_MS = 90_000

function notUpYet(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && NOT_UP_YET.has(code)) return true
  }
  return false
}

/**
 * One-shot role of the stack: applies migrations under the advisory lock and exits 0.
 * `docker compose restart` starts it together with `db`, so it waits up to 90 s for the
 * database to come up; a failed migration is never retried.
 */
async function runMigrate(config: Config, logger: Logger): Promise<void> {
  const migrate = () =>
    runMigrations({
      databaseUrl: required(config.MIGRATE_DATABASE_URL, 'MIGRATE_DATABASE_URL'),
      appliedBy: `migrate@${hostname()}`,
      ...(config.MIGRATIONS_DIR ? { migrationsDir: config.MIGRATIONS_DIR } : {}),
      log: (line) => logger.info(line),
    })
  const deadline = Date.now() + MIGRATE_WAIT_MS
  let result: Awaited<ReturnType<typeof migrate>>
  for (;;) {
    try {
      result = await migrate()
      break
    } catch (error) {
      if (!notUpYet(error) || Date.now() > deadline) throw error
      logger.info({ err: error }, 'database is not up yet, waiting')
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
  }
  logger.info(
    { version: result.version, applied: result.applied.map((file) => file.version) },
    result.applied.length > 0 ? 'migrations applied' : 'schema is up to date',
  )
}

const VOLUME_WAIT_MS = 30_000

/** Storage paths of the role that are not mounted (`REQUIRE_VOLUMES`, `REQUIRE_MOUNTS`). */
async function missingStorage(config: Config): Promise<string[]> {
  const mounts = await Promise.all(config.REQUIRE_MOUNTS.map(isMountpoint))
  return [
    ...(await missingVolumes(config.REQUIRE_VOLUMES)),
    ...config.REQUIRE_MOUNTS.filter((_, index) => !mounts[index]),
  ]
}

/**
 * SPEC §12.2: while the disks are not mounted (disk E: in the VM) the workers do not start,
 * otherwise prefetch, previews and frames would land on the system disk. The worker waits
 * here, says so once, and starts when the volume marks appear (`ops/up.sh`).
 */
async function waitForStorage(config: Config, logger: Logger): Promise<void> {
  let warned = false
  for (;;) {
    const missing = await missingStorage(config)
    if (missing.length === 0) return
    if (!warned) {
      logger.warn({ missing }, 'storage is not mounted: the worker waits and claims nothing')
      warned = true
    }
    await new Promise((resolve) => setTimeout(resolve, VOLUME_WAIT_MS))
  }
}

/** Discovery and fetch from the cloud folders of the models (SPEC §6.1), role `worker`. */
function intakeHandlers(
  config: Config,
  store: BlobStore,
  mediaExport: WorkHandler | undefined,
): Partial<Record<values.WorkKind, WorkHandler>> {
  const factory = envSourceFactory(process.env)
  return {
    scan: scanHandler(factory),
    // «Скачать исходник» of several files is one ZIP; other exports stay the pipeline's.
    export: draftZipExport(store, mediaExport),
    fetch: fetchHandler({
      factory,
      store,
      fetchAheadGb: config.FETCH_AHEAD_GB,
      space: {
        file: config.HOST_SPACE_FILE,
        warnGb: config.SPACE_WARN_GB,
        stopGb: config.SPACE_STOP_GB,
      },
    }),
  }
}

async function runWorker(role: WorkRole, config: Config, logger: Logger): Promise<void> {
  let stopWork: () => Promise<void> = async () => {}
  // A stop while waiting for the disks just exits: nothing is claimed yet.
  onStop(logger, () => stopWork())
  await waitForStorage(config, logger)

  const pool = createPool(required(config.DATABASE_URL, 'DATABASE_URL'), {
    max: 5,
    applicationName: role,
  })
  const db = createDb(pool)
  const log = (line: string, error?: unknown) =>
    error === undefined ? logger.info(line) : logger.error({ err: error }, line)
  const store = new BlobStore({
    dataRoot: required(config.DATA_ROOT, 'DATA_ROOT'),
    derivedRoot: required(config.DERIVED_ROOT, 'DERIVED_ROOT'),
    tmpRoot: required(config.TMP_ROOT, 'TMP_ROOT'),
  })
  const owner = `${role}:${hostname()}:${process.pid}`
  // Interrupted file operations of this role are settled against the disk before any claim
  // (schema §9.3 «Операции с файлами»).
  const reconciled = await reconcileStorage(db, store, `${role}:`)
  logger.info({ ...reconciled }, 'storage operations reconciled')
  // The tool versions and recipes of this image; a new pipeline version becomes current.
  const env = await createMediaEnv({ db, store, lp: config.SVTAV1_LP, owner, log })
  logger.info({ pipeline_version: env.pipelineVersion, tools: env.versions }, 'media pipeline')
  const handlers: Partial<Record<values.WorkKind, WorkHandler>> = {
    ...mediaHandlers(role, env),
    // Discovery from the cloud folders of the models (SPEC §6.1).
    ...intakeMediaHandlers(role, env),
    ...(role === 'worker' ? intakeHandlers(config, store, mediaHandlers(role, env).export) : {}),
    // The legacy pass of stage 3 and its dry run (SPEC §6.3).
    ...(role === 'worker' ? { import_parse: importParseHandler() } : {}),
  }
  const runner = new WorkRunner({
    db,
    role,
    handlers,
    owner,
    limits: {
      fetch: config.FETCH_JOBS,
      encode: config.ENCODE_JOBS,
      copy: config.COPY_JOBS,
      image: config.IMAGE_JOBS,
    },
    ...(role === 'worker-image' ? { dynamicLimits: imageThrottle(config.IMAGE_JOBS) } : {}),
    gate: createWorkGate(),
    log,
  })
  const stopExports = role === 'worker' ? startExportSweep(store, log) : () => {}
  const stopStaging = role === 'worker' ? startStagingSweep(db, store, log) : () => {}
  // Old rendition generations go once their rebuild has served a day (SPEC §9.1).
  const stopCollector = role === 'worker' ? startGenerationCollector(db, store, log) : () => {}
  const stopSweep = () => {
    stopExports()
    stopStaging()
    stopCollector()
  }
  // Periodic works (Hub polls, source scans) are scheduled only by `worker`; their streams
  // come with their stages. A source's streams exist while its token is in the environment.
  const startedAt = new Date()
  const scheduler =
    role === 'worker'
      ? new WorkScheduler({
          db,
          streams: () => scanStreams(db, process.env, startedAt),
          pollMs: 10_000,
          log,
        })
      : null
  stopWork = async () => {
    stopSweep()
    await scheduler?.stop()
    // Running works go back to the queue without counting the attempt.
    await runner.stop()
    await pool.end()
  }
  runner.start()
  scheduler?.start()
  logger.info({ kinds: Object.keys(handlers), owner: runner.owner }, 'worker started')
}

const config = readConfig()
const logger = createLogger({ level: config.LOG_LEVEL, role: config.ROLE })

try {
  switch (config.ROLE) {
    case 'web':
      await runWeb(config, logger)
      break
    case 'migrate':
      await runMigrate(config, logger)
      process.exit(0)
      break
    default:
      await runWorker(config.ROLE, config, logger)
  }
} catch (error) {
  logger.fatal({ err: error }, `${config.ROLE} failed`)
  process.exit(1)
}
