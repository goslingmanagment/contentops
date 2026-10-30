import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle is the typed SQL layer; the schema lives in `migrations/*.sql`.
 * `drizzle-kit pull` mirrors a migrated database into `drizzle/` (run through
 * `pnpm --filter @contentops/db generate`, never by hand); `drizzle-kit push` is forbidden.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: process.env.DRIZZLE_OUT ?? './drizzle',
  schema: './drizzle/schema.ts',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  introspect: { casing: 'camel' },
})
