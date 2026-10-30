// Regenerates the golden `schema.sql` and the Drizzle mirror from the migrations:
// `pnpm --filter @contentops/db generate` (needs Docker).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runMigrations } from '../src/migrate.ts'
import { GENERATED_FILES, PACKAGE_DIR, renderGenerated } from '../src/testing/generated.ts'
import { createDatabase, databaseUrl, startPostgres } from '../src/testing/postgres.ts'

const { info, container } = await startPostgres()
try {
  await createDatabase(info, 'contentops')
  await runMigrations({
    databaseUrl: databaseUrl(info, 'contentops', 'migrate'),
    appliedBy: 'generate',
    log: (line) => console.log(line),
  })
  const files = await renderGenerated(info, 'contentops')
  for (const file of GENERATED_FILES) {
    await writeFile(join(PACKAGE_DIR, file), files[file])
    console.log(`wrote ${file}`)
  }
} finally {
  await container.stop()
}
