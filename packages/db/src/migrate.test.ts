import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMigrations, MIGRATIONS_DIR, MigrationError, runMigrations } from './migrate.ts'
import { createTestDatabase, dumpSchema, withClient } from './testing/index.ts'

const dirs: string[] = []

async function copyOfMigrations(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'contentops-migrations-'))
  dirs.push(dir)
  await cp(MIGRATIONS_DIR, dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function ledger(url: string) {
  return withClient(url, async (client) => {
    const { rows } = await client.query(
      'SELECT version, name, checksum, applied_by FROM schema_migrations ORDER BY version',
    )
    return rows
  })
}

describe('runMigrations', () => {
  it('applies every file to an empty database and a repeat changes nothing', async () => {
    const db = await createTestDatabase({ migrated: false })
    const files = await loadMigrations()
    const lines: string[] = []

    const first = await runMigrations({
      databaseUrl: db.url('migrate'),
      appliedBy: 'test',
      log: (line) => lines.push(line),
    })
    expect(first.applied.map((m) => m.version)).toEqual(files.map((f) => f.version))
    expect(lines[0]).toBe('applying 0001_foundation.sql')
    const rows = await ledger(db.url('migrate'))
    expect(rows).toEqual(
      files.map((f) => ({
        version: f.version,
        name: f.name,
        checksum: f.checksum,
        applied_by: 'test',
      })),
    )
    const dump = await dumpSchema(db.info, db.name)

    const second = await runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'again' })
    expect(second.applied).toEqual([])
    expect(second.version).toBe(first.version)
    expect(await ledger(db.url('migrate'))).toEqual(rows)
    expect(await dumpSchema(db.info, db.name)).toBe(dump)
  })

  it('two runners at once apply each file once', async () => {
    const db = await createTestDatabase({ migrated: false })
    const results = await Promise.all([
      runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'a' }),
      runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'b' }),
    ])
    const files = await loadMigrations()
    expect(results.flatMap((r) => r.applied.map((m) => m.version)).sort()).toEqual(
      files.map((f) => f.version),
    )
    expect(results.some((r) => r.applied.length === 0)).toBe(true)
    expect(await ledger(db.url('migrate'))).toHaveLength(files.length)
  })

  it('a crash between the DDL and the version row leaves nothing applied', async () => {
    const db = await createTestDatabase({ migrated: false })
    const dir = await copyOfMigrations()
    await runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'test', migrationsDir: dir })
    const next = join(dir, '9001_crash.sql')
    // The process dies after its DDL ran and before the runner writes the version row.
    await writeFile(
      next,
      'CREATE TABLE crash_probe (id integer);\nSELECT pg_terminate_backend(pg_backend_pid());\n',
    )
    await expect(
      runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'test', migrationsDir: dir }),
    ).rejects.toThrow()
    await withClient(db.url('migrate'), async (client) => {
      const probe = await client.query("SELECT to_regclass('public.crash_probe') AS t")
      expect(probe.rows[0].t).toBeNull()
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = 9001')
      expect(applied.rowCount).toBe(0)
    })

    await writeFile(next, 'CREATE TABLE crash_probe (id integer);\n')
    const retry = await runMigrations({
      databaseUrl: db.url('migrate'),
      appliedBy: 'test',
      migrationsDir: dir,
    })
    expect(retry.applied).toEqual([{ version: 9001, name: 'crash' }])
  })

  it('a failing file rolls back its DDL and names the line', async () => {
    const db = await createTestDatabase()
    const dir = await copyOfMigrations()
    await writeFile(
      join(dir, '9002_broken.sql'),
      'CREATE TABLE half_done (id integer);\n\nCREATE TABLE typo (id integer,);\n',
    )
    const error = await runMigrations({
      databaseUrl: db.url('migrate'),
      appliedBy: 'test',
      migrationsDir: dir,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).code).toBe('apply_failed')
    expect((error as MigrationError).message).toMatch(/^9002_broken\.sql:3: syntax error/)
    await withClient(db.url('migrate'), async (client) => {
      const probe = await client.query("SELECT to_regclass('public.half_done') AS t")
      expect(probe.rows[0].t).toBeNull()
    })
  })

  it('a changed checksum of an applied file stops the run', async () => {
    const db = await createTestDatabase()
    const dir = await copyOfMigrations()
    const file = join(dir, '0001_foundation.sql')
    await writeFile(file, `${await readFile(file, 'utf8')}\n-- edited after apply\n`)
    await writeFile(join(dir, '9003_after.sql'), 'CREATE TABLE never_applied (id integer);\n')
    const error = await runMigrations({
      databaseUrl: db.url('migrate'),
      appliedBy: 'test',
      migrationsDir: dir,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MigrationError)
    expect((error as MigrationError).code).toBe('checksum_mismatch')
    expect((error as MigrationError).message).toContain('0001_foundation.sql changed')
    await withClient(db.url('migrate'), async (client) => {
      const probe = await client.query("SELECT to_regclass('public.never_applied') AS t")
      expect(probe.rows[0].t).toBeNull()
    })
  })

  it('refuses a file older than the applied ones and a file with its own transaction', async () => {
    const db = await createTestDatabase()
    const dir = await copyOfMigrations()
    await writeFile(join(dir, '9010_late.sql'), 'SELECT 1;\n')
    await runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'test', migrationsDir: dir })
    await writeFile(join(dir, '9005_inserted.sql'), 'SELECT 1;\n')
    await expect(
      runMigrations({ databaseUrl: db.url('migrate'), appliedBy: 'test', migrationsDir: dir }),
    ).rejects.toMatchObject({ code: 'out_of_order' })

    const own = await copyOfMigrations()
    await writeFile(join(own, '9001_own.sql'), 'BEGIN;\nSELECT 1;\nCOMMIT;\n')
    await expect(loadMigrations(own)).rejects.toMatchObject({ code: 'bad_file' })
  })
})
