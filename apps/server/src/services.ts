import type { Db } from '@contentops/db'
import type { RunCommand } from './commands'
import type { BlobStore } from './media/storage'
import type { SpaceOptions } from './space'

/** Which integrations have their secrets in the environment (SPEC §8: «не настроено»). */
export interface IntegrationSecrets {
  hub: boolean
}

/** What the handlers share: the database, the command pipeline and the outside world. */
export interface Services {
  db: Db
  command: RunCommand
  /** `PUBLIC_URL` is https: cookies get `Secure`. */
  secureCookies: boolean
  secrets: IntegrationSecrets
  /**
   * Where the token variables of the cloud sources are read (`sources.credentials_ref`, SPEC
   * §8): the process environment in the product.
   */
  sourceEnv: Record<string, string | undefined>
  /** Where the host reports free space, and the pilot thresholds (SPEC §12.2). */
  space: SpaceOptions
  /** Storage roots: bytes go out by `X-Accel-Redirect` to their keys. */
  store: BlobStore
}
