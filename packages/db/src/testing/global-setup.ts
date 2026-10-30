import type { TestProject } from 'vitest/node'
import { runMigrations } from '../migrate.ts'
import { createDatabase, databaseUrl, startPostgres, TEMPLATE_DATABASE } from './postgres.ts'

/**
 * Vitest globalSetup: one `postgres:18` container per test run with both roles and a
 * migrated template database; every test file clones its own database from it.
 * Use from another package: `globalSetup: ['@contentops/db/testing/global-setup']`.
 */
export default async function setup(project: TestProject) {
  const { info, container } = await startPostgres()
  await createDatabase(info, TEMPLATE_DATABASE)
  await runMigrations({
    databaseUrl: databaseUrl(info, TEMPLATE_DATABASE, 'migrate'),
    appliedBy: 'vitest',
  })
  project.provide('contentopsPostgres', info)
  return async () => {
    await container.stop()
  }
}
