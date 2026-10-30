import { defineConfig } from 'vitest/config'

/**
 * Media tests (`*.media.test.ts`) need the pinned FFmpeg, SVT-AV1, libvips/libheif and
 * heif-enc, so they run in the product image (CI job `media`, Dockerfile `media-test`, which
 * sets CONTENTOPS_MEDIA_TOOLS=1). Elsewhere — `pnpm check` on the runner, a laptop — only
 * the pure tests run.
 */
const withTools = process.env.CONTENTOPS_MEDIA_TOOLS === '1'
if (!withTools) {
  console.info('@contentops/media: media tests skipped (CONTENTOPS_MEDIA_TOOLS!=1); CI job `media` runs them')
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: withTools ? [] : ['src/**/*.media.test.ts'],
    globalSetup: withTools ? ['src/testing/global-setup.ts'] : [],
    testTimeout: withTools ? 240_000 : 5_000,
    hookTimeout: 600_000,
    maxWorkers: withTools ? 2 : undefined,
  },
})
