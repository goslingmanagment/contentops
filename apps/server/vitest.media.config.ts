import { defineConfig } from 'vitest/config'

/**
 * The media pipeline on the database (PLAN 2б): handlers, renditions, masters and the
 * download path on generated fixtures. Runs in the product image with the Docker socket for
 * Testcontainers (CI job `media`): `pnpm --filter @contentops/server test:media`.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.media.test.ts'],
    globalSetup: ['@contentops/db/testing/global-setup', '@contentops/media/testing/global-setup'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    maxWorkers: 2,
  },
})
