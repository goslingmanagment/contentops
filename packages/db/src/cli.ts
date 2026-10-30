#!/usr/bin/env node
// contentops-db migrate                 — apply migrations (DATABASE_URL of the migrate role)
// contentops-db bootstrap <config.json> — models, pages, counters, first owner (DATABASE_URL)
// contentops-db reset-password <login>  — new password from CONTENTOPS_NEW_PASSWORD or the first
//                                         line of stdin; revokes that person's sessions
import { readFile } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { bootstrap } from './bootstrap.ts'
import { createDb, createPool } from './client.ts'
import { runMigrations } from './migrate.ts'
import { resetPassword } from './reset-password.ts'

const USAGE = 'usage: contentops-db migrate | bootstrap <config.json> | reset-password <login>'

async function readStdinLine(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('new password: ')
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
    if (Buffer.concat(chunks).includes(10)) break
  }
  return (Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '').trim()
}

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args
  const databaseUrl = process.env.DATABASE_URL
  if (!command || !['migrate', 'bootstrap', 'reset-password'].includes(command)) {
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
  if (command === 'reset-password') {
    const [login] = rest
    if (!login) {
      console.error(USAGE)
      return 2
    }
    const password = process.env.CONTENTOPS_NEW_PASSWORD ?? (await readStdinLine())
    const pool = createPool(databaseUrl, { max: 2, applicationName: 'contentops-reset-password' })
    try {
      const result = await resetPassword(createDb(pool), login, password)
      console.log(`password of ${login} set; sessions revoked: ${result.revokedSessions}`)
    } finally {
      await pool.end()
    }
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
