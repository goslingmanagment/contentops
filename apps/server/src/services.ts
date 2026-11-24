import type { Db } from '@contentops/db'
import type { PersonDoor } from '@contentops/hub'
import type { HubSigninService } from './auth/hub-signin'
import type { RunCommand } from './commands'
import type { BlobStore } from './media/storage'
import type { SpaceOptions } from './space'

/** Which integrations have their secrets in the environment (SPEC §8: «не настроено»). */
export interface IntegrationSecrets {
  hub: boolean
  /** The hub's console (`HUB_BASE_URL`): links to its board «Кастомы». */
  hubBaseUrl?: string | null
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
  /** The share with the PC's lists (`ORIGINALS_HOST_DIR`, SPEC §9.4, §12.2); null — none: the line has no lists, the release gives nothing. */
  originalsHostDir?: string | null
  /** Storage roots: bytes go out by `X-Accel-Redirect` to their keys. */
  store: BlobStore
  /** «Войти через хаб» (SPEC §11.1); absent — not configured. */
  hubSignin?: HubSigninService | null
  /**
   * Hub's person's door (package C3): «Съёмка» reads and moves custom orders AS THE SIGNED-IN
   * PERSON (their session's grant); absent — Hub's sign-in is not configured.
   */
  personDoor?: PersonDoor | null
  /** Hub's model slug → ContentOps' model code where they differ (`HUB_MODEL_MAP`: `test=smoke`). */
  hubModelMap?: Record<string, string>
}
