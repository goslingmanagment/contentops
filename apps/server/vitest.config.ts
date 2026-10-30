import { defineConfig } from 'vitest/config'

/**
 * `*.media.test.ts` run the media pipeline on generated fixtures with the pinned FFmpeg,
 * SVT-AV1 and libvips/libheif: only inside the product image (CI job `media`,
 * `vitest.media.config.ts`). Here — the database tests.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'src/**/*.media.test.ts'],
    globalSetup: ['@contentops/db/testing/global-setup'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
})
