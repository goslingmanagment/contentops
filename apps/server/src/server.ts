import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { createAuthorize } from './access'
import { type AppDeps, buildApp } from './app'
import { createAuthenticate } from './auth/authenticate'
import { createCommands, createFailureRecorder } from './commands'
import { createHandlers } from './handlers/index'
import { envSourceFactory } from './intake/source-client'
import { registerSourceThumbs } from './intake/source-thumbs'
import { registerTus } from './intake/tus'
import { BlobStore, type StorageRoots } from './media/storage'
import type { IntegrationSecrets } from './services'
import type { SpaceOptions } from './space'

export interface ServerOptions {
  db: Db
  /** `PUBLIC_URL`: https gives `Secure` cookies. */
  publicUrl: string
  secrets: IntegrationSecrets
  /** Token variables of the cloud sources; `process.env` by default. */
  sourceEnv?: Record<string, string | undefined>
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
    sourceEnv: options.sourceEnv ?? process.env,
    space: options.space ?? { file: undefined, warnGb: 200, stopGb: 100 },
    store: new BlobStore(options.storage),
  }
  const authenticate = createAuthenticate(db)
  const authorize = createAuthorize(db)
  const deps: AppDeps = {
    handlers: createHandlers(services),
    authenticate,
    routes: (api) => {
      registerSourceThumbs(api, {
        db,
        authenticate,
        factory: envSourceFactory(services.sourceEnv),
        cacheDir: options.storage.tmpRoot,
      })
      registerTus(api, { db, authenticate, authorize, dataRoot: services.store.roots.dataRoot })
    },
    authorize,
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
