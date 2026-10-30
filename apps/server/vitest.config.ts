import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['@contentops/db/testing/global-setup'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
})
