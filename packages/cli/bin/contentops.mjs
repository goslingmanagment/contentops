#!/usr/bin/env node
// The workspace packages are TypeScript sources with extensionless imports: tsx loads
// them, so the CLI runs from a copy of the repo after `pnpm install`, without a build.
import { register } from 'tsx/esm/api'

register()
const { main } = await import('../src/main.ts')
process.exitCode = await main(process.argv.slice(2))
