import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { createAuthorize } from './access'
import { type AppDeps, buildApp } from './app'
import { createAuthenticate } from './auth/authenticate'
import { createCommands, createFailureRecorder } from './commands'
import { createHandlers } from './handlers/index'
import type { IntegrationSecrets } from './services'

export interface ServerOptions {
  db: Db
  /** `PUBLIC_URL`: https gives `Secure` cookies. */
  publicUrl: string
  secrets: IntegrationSecrets
  logger?: Logger
  trustedProxy?: readonly string[]
  requireMounts?: readonly string[]
}

/** The `web` role: the table routes on the database, sessions, rights and the journal. */
export function buildServer(options: ServerOptions) {
  const { db } = options
  const services = {
    db,
    command: createCommands(db),
    secureCookies: options.publicUrl.startsWith('https:'),
    secrets: options.secrets,
  }
  const deps: AppDeps = {
    handlers: createHandlers(services),
    authenticate: createAuthenticate(db),
    authorize: createAuthorize(db),
    recordFailure: createFailureRecorder(db),
    checks: { db: () => db.execute(sql`SELECT 1`) },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.trustedProxy ? { trustedProxy: options.trustedProxy } : {}),
    ...(options.requireMounts ? { requireMounts: options.requireMounts } : {}),
  }
  return buildApp(deps)
}
