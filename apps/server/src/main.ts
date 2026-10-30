import type { Logger } from 'pino'
import { buildApp } from './app'
import { type Config, ConfigError, loadConfig } from './config'
import { createLogger } from './logger'

function readConfig(): Config {
  try {
    return loadConfig()
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
}

async function runWeb(config: Config, logger: Logger): Promise<void> {
  const app = buildApp({
    logger,
    trustedProxy: config.TRUSTED_PROXY,
    requireMounts: config.REQUIRE_MOUNTS,
  })
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
  case 'worker':
  case 'worker-video':
  case 'worker-image':
    // Wired to @contentops/db by the next PR of 1а.
    logger.error('role is not wired yet')
    process.exitCode = 1
    break
}
