import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERATED_FILES, PACKAGE_DIR, renderGenerated } from './testing/generated.ts'
import { createTestDatabase } from './testing/index.ts'

describe('generated files', () => {
  it('golden schema.sql and the Drizzle mirror equal what the migrations produce', async () => {
    const db = await createTestDatabase()
    const rendered = await renderGenerated(db.info, db.name)
    for (const file of GENERATED_FILES) {
      const committed = await readFile(join(PACKAGE_DIR, file), 'utf8')
      expect(
        committed,
        `${file} is stale: run \`pnpm --filter @contentops/db generate\` and commit the result`,
      ).toBe(rendered[file])
    }
  }, 120_000)
})
