import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

/** `packages/db/migrations`: `NNNN_name.sql`, applied in order of the number. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/** Session advisory lock held by the runner on its own connection ("co-mig"). */
export const MIGRATION_LOCK_KEY = 0x636f_6d69_67

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/
/** `BEGIN;` of its own would end the runner's transaction (a PL/pgSQL `BEGIN` has no `;`). */
const OWN_TRANSACTION = /^\s*(BEGIN\s*;|START\s+TRANSACTION\b|COMMIT\s*;|ROLLBACK\s*;)/im

export interface MigrationFile {
  version: number
  name: string
  file: string
  sql: string
  /** SHA-256 of the file bytes, hex. */
  checksum: string
}

export interface MigrateOptions {
  /** Connection of the `contentops_migrate` role (or a member of it). */
  databaseUrl: string
  /** Who applies: written to `schema_migrations.applied_by`. */
  appliedBy: string
  log?: (line: string) => void
  /** Tests point the runner at a copy of the files. */
  migrationsDir?: string
}

export interface MigrateResult {
  applied: Array<{ version: number; name: string }>
  /** Highest applied version after the run; 0 for an empty database. */
  version: number
}

export type MigrationErrorCode =
  | 'bad_file'
  | 'checksum_mismatch'
  | 'missing_file'
  | 'out_of_order'
  | 'apply_failed'

export class MigrationError extends Error {
  readonly code: MigrationErrorCode

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MigrationError'
    this.code = code
  }
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files: MigrationFile[] = []
  for (const file of (await readdir(dir)).sort()) {
    if (!file.endsWith('.sql')) continue
    const match = FILE_NAME.exec(file)
    if (!match) throw new MigrationError('bad_file', `${file}: expected NNNN_name.sql`)
    const bytes = await readFile(join(dir, file))
    const sql = bytes.toString('utf8')
    if (OWN_TRANSACTION.test(sql)) {
      throw new MigrationError('bad_file', `${file}: the runner owns the transaction`)
    }
    const version = Number(match[1])
    if (files.some((known) => known.version === version)) {
      throw new MigrationError('bad_file', `${file}: version ${version} appears twice`)
    }
    files.push({
      version,
      name: match[2] ?? '',
      file,
      sql,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  return files
}

/**
 * Applies pending migrations under an advisory lock on a dedicated connection.
 * Each file runs in one transaction together with its `schema_migrations` row;
 * a changed checksum of an applied file stops the run; a repeat is a no-op.
 */
export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? (() => {})
  const files = await loadMigrations(options.migrationsDir)
  const client = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: 'contentops-migrate',
  })
  // A dropped connection fails the query in flight; the event must not crash the process.
  client.on('error', (error) => log(`migrations: connection lost: ${error.message}`))
  await client.connect()
  try {
    await client.query('SET ROLE contentops_migrate')
    await client.query('SET search_path TO public')
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      const done = await appliedVersions(client)
      const pending = checkLedger(files, done)
      const applied: MigrateResult['applied'] = []
      for (const migration of pending) {
        log(`applying ${migration.file}`)
        await applyOne(client, migration, options.appliedBy)
        applied.push({ version: migration.version, name: migration.name })
      }
      if (applied.length === 0) log('migrations: nothing to apply')
      const version = Math.max(0, ...done.keys(), ...applied.map((a) => a.version))
      return { applied, version }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
}

async function appliedVersions(client: pg.Client): Promise<Map<number, string>> {
  const ledger = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  )
  if (!ledger.rows[0]?.exists) return new Map()
  const rows = await client.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  )
  return new Map(rows.rows.map((row) => [row.version, row.checksum]))
}

function checkLedger(files: MigrationFile[], done: Map<number, string>): MigrationFile[] {
  for (const [version, checksum] of done) {
    const file = files.find((candidate) => candidate.version === version)
    if (!file) {
      throw new MigrationError(
        'missing_file',
        `migration ${version} is applied but its file is gone; the database is newer than this code`,
      )
    }
    if (file.checksum !== checksum) {
      throw new MigrationError(
        'checksum_mismatch',
        `${file.file} changed after it was applied (checksum ${checksum.slice(0, 12)}… in the database, ${file.checksum.slice(0, 12)}… on disk); add a new migration instead`,
      )
    }
  }
  const latest = Math.max(0, ...done.keys())
  const pending = files.filter((file) => !done.has(file.version))
  const early = pending.find((file) => file.version < latest)
  if (early) {
    throw new MigrationError(
      'out_of_order',
      `${early.file} is older than applied migration ${latest}; number new files after it`,
    )
  }
  return pending
}

async function applyOne(client: pg.Client, migration: MigrationFile, appliedBy: string) {
  await client.query('BEGIN')
  try {
    await client.query(migration.sql)
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum, applied_by) VALUES ($1, $2, $3, $4)',
      [migration.version, migration.name, migration.checksum, appliedBy],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw new MigrationError(
      'apply_failed',
      `${migration.file}${lineOf(migration.sql, error)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function lineOf(sql: string, error: unknown): string {
  const position = Number((error as { position?: string }).position)
  if (!Number.isFinite(position) || position <= 0) return ''
  return `:${sql.slice(0, position).split('\n').length}`
}
