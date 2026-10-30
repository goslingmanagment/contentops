import { hostname } from 'node:os'
import { createDb, createPool, runMigrations } from '@contentops/db'
import type { Logger } from 'pino'
import { type Config, ConfigError, loadConfig } from './config'
import { createLogger } from './logger'
import { buildServer } from './server'

function readConfig(): Config {
  try {
    return loadConfig()
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

/** Present only when set: `loadConfig` already checked what the role needs. */
function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is not set`)
  return value
}

async function runWeb(config: Config, logger: Logger): Promise<void> {
  const pool = createPool(required(config.DATABASE_URL, 'DATABASE_URL'), { applicationName: 'web' })
  const app = buildServer({
    db: createDb(pool),
    publicUrl: required(config.PUBLIC_URL, 'PUBLIC_URL'),
    // The app starts without the secrets of switched-off integrations (SPEC §8).
    secrets: {
      ydisk: config.YDISK_TOKEN !== undefined,
      dropbox: config.DROPBOX_TOKEN !== undefined,
      hub: config.HUB_API_KEY !== undefined && config.HUB_BASE_URL !== undefined,
    },
    logger,
    trustedProxy: config.TRUSTED_PROXY,
    requireMounts: config.REQUIRE_MOUNTS,
  })
  app.addHook('onClose', () => pool.end())
  let closing = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await app.listen({ host: config.HOST, port: config.PORT })
}

const config = readConfig()
const logger = createLogger({ level: config.LOG_LEVEL, role: config.ROLE })

switch (config.ROLE) {
  case 'web':
    try {
      await runWeb(config, logger)
    } catch (error) {
      logger.fatal({ err: error }, 'web failed to start')
      process.exit(1)
    }
    break
  case 'migrate':
    try {
      const result = await runMigrations({
        databaseUrl: required(config.MIGRATE_DATABASE_URL, 'MIGRATE_DATABASE_URL'),
        appliedBy: `migrate@${hostname()}`,
        log: (line) => logger.info(line),
      })
      logger.info({ version: result.version }, 'migrations applied')
    } catch (error) {
      logger.fatal({ err: error }, 'migrations failed')
      process.exitCode = 1
    }
    break
  case 'worker':
  case 'worker-video':
  case 'worker-image':
    // Wired to @contentops/db by the next PR of 1а.
    logger.error('role is not wired yet')
    process.exitCode = 1
    break
}
