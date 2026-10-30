import { defineConfig, devices } from '@playwright/test'
import { E2E } from './src/env.ts'

/**
 * End-to-end scenarios of both human roles on the whole stack (SPEC §12.0 «Тесты», PLAN 4).
 * One worker: the scenarios share one database, as people share the product.
 */
export default defineConfig({
  testDir: './src',
  testMatch: /.*\.(spec|setup)\.ts$/,
  outputDir: './test-results',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: E2E.baseUrl,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /\.setup\.ts$/ },
    { name: 'scenarios', testMatch: /\.spec\.ts$/, dependencies: ['setup'] },
  ],
  webServer: [
    {
      command: 'node src/stack.ts',
      url: `http://127.0.0.1:${E2E.serverPort}/healthz`,
      timeout: 600_000,
      reuseExistingServer: !process.env.CI,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
    },
    {
      // The production build (`pnpm --filter @contentops/web build` first) with `/api`
      // proxied to the server, as nginx serves it in the stack.
      command: `pnpm --filter @contentops/web exec vite preview --host 127.0.0.1 --port ${E2E.webPort} --strictPort`,
      url: E2E.baseUrl,
      env: { SERVER_PORT: String(E2E.serverPort) },
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
