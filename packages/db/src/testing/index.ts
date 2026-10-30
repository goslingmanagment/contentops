import { randomUUID } from 'node:crypto'
import { inject } from 'vitest'
import {
  createDatabase,
  type DbRole,
  databaseUrl,
  dropDatabase,
  type PostgresInfo,
  TEMPLATE_DATABASE,
} from './postgres.ts'

export {
  APP_ROLE,
  createDatabase,
  databaseUrl,
  dropDatabase,
  dumpSchema,
  MIGRATE_ROLE,
  normaliseDump,
  POSTGRES_IMAGE,
  type PostgresInfo,
  startPostgres,
  TEMPLATE_DATABASE,
  withClient,
} from './postgres.ts'

export interface TestDatabase {
  name: string
  info: PostgresInfo
  /** Connection string; tests connect as the app role unless they need another. */
  url(role?: DbRole): string
  drop(): Promise<void>
}

/** Server started by `global-setup.ts`. */
export function testPostgres(): PostgresInfo {
  return inject('contentopsPostgres')
}

/**
 * A fresh database for one test file: a copy of the migrated template, or an empty
 * database (`{ migrated: false }`) for runner tests.
 */
export async function createTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const info = testPostgres()
  const name = `test_${randomUUID().replaceAll('-', '')}`
  await createDatabase(info, name, {
    template: options.migrated === false ? 'template0' : TEMPLATE_DATABASE,
  })
  return {
    name,
    info,
    url: (role: DbRole = 'app') => databaseUrl(info, name, role),
    drop: () => dropDatabase(info, name),
  }
}
