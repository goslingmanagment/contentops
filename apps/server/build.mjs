// Production bundle: workspace packages (raw .ts) go inside, npm dependencies stay external.
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const root = new URL('.', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@contentops/'))

await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
})
