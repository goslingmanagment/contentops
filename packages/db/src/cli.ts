#!/usr/bin/env node
// contentops-db migrate                 — apply migrations (DATABASE_URL of the migrate role)
// contentops-db bootstrap <config.json> — models, pages, counters, first owner (DATABASE_URL)
import { readFile } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { bootstrap } from './bootstrap.ts'
import { createDb, createPool } from './client.ts'
import { runMigrations } from './migrate.ts'

const USAGE = 'usage: contentops-db migrate | contentops-db bootstrap <config.json>'

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args
  const databaseUrl = process.env.DATABASE_URL
  if (!command || !['migrate', 'bootstrap'].includes(command)) {
    console.error(USAGE)
    return 2
  }
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set')
    return 2
  }
  if (command === 'migrate') {
    const result = await runMigrations({
      databaseUrl,
      appliedBy: process.env.MIGRATE_APPLIED_BY ?? `${userInfo().username}@${hostname()}`,
      log: (line) => console.log(line),
    })
    console.log(`schema version ${result.version}`)
    return 0
  }
  const [configPath] = rest
  if (!configPath) {
    console.error(USAGE)
    return 2
  }
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  const pool = createPool(databaseUrl, { max: 2, applicationName: 'contentops-bootstrap' })
  try {
    await bootstrap(createDb(pool), config, { log: (line) => console.log(line) })
  } finally {
    await pool.end()
  }
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  },
)
