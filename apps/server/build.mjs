// Production bundle: workspace packages (raw .ts) go inside, npm dependencies stay external.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = new URL('.', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@contentops/'))

// dist/main.js — every role of the image; dist/db.js — the `contentops-db` command
// (bootstrap, reset-password) for the deploy, next to the migrations (MIGRATIONS_DIR);
// dist/seed.js — the fictional catalog for the pilot's test runs before stage 3.
await build({
  absWorkingDir: root,
  entryPoints: { main: 'src/main.ts', db: '../../packages/db/src/cli.ts', seed: 'src/seed.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
})
