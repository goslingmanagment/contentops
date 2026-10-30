import type { Db } from '@contentops/db'
import type { RunCommand } from './commands'

/** Which integrations have their secrets in the environment (SPEC §8: «не настроено»). */
export interface IntegrationSecrets {
  ydisk: boolean
  dropbox: boolean
  hub: boolean
}

/** What the handlers share: the database, the command pipeline and the outside world. */
export interface Services {
  db: Db
  command: RunCommand
  /** `PUBLIC_URL` is https: cookies get `Secure`. */
  secureCookies: boolean
  secrets: IntegrationSecrets
}
