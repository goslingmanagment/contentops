import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { createAuthorize } from './access'
import { type AppDeps, buildApp } from './app'
import { createAuthenticate } from './auth/authenticate'
import { createCommands, createFailureRecorder } from './commands'
import { createHandlers } from './handlers/index'
import { BlobStore, type StorageRoots } from './media/storage'
import type { IntegrationSecrets } from './services'
import type { SpaceOptions } from './space'

export interface ServerOptions {
  db: Db
  /** `PUBLIC_URL`: https gives `Secure` cookies. */
  publicUrl: string
  secrets: IntegrationSecrets
  /** Free space of the host disks for «Состояние» and the space card. */
  space?: SpaceOptions
  logger?: Logger
  trustedProxy?: readonly string[]
  requireMounts?: readonly string[]
  requireVolumes?: readonly string[]
  /** `DATA_ROOT`, `DERIVED_ROOT`, `TMP_ROOT`. */
  storage: StorageRoots
  /** `FILES_DIRECT=1`: stream files from `web` (development without nginx). */
  filesDirect?: boolean
}

/** The `web` role: the table routes on the database, sessions, rights and the journal. */
export function buildServer(options: ServerOptions) {
  const { db } = options
  const services = {
    db,
    command: createCommands(db),
    secureCookies: options.publicUrl.startsWith('https:'),
    secrets: options.secrets,
    space: options.space ?? { file: undefined, warnGb: 200, stopGb: 100 },
    store: new BlobStore(options.storage),
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
    ...(options.requireVolumes ? { requireVolumes: options.requireVolumes } : {}),
    filesDirect: options.filesDirect === true,
  }
  return buildApp(deps)
}
