import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'

const run = promisify(execFile)

/** One image for tests, the golden dump and the mirror: pg_dump must match the server. */
export const POSTGRES_IMAGE = 'postgres:18.6'
export const MIGRATE_ROLE = 'contentops_migrate'
export const APP_ROLE = 'contentops_app'
export const TEMPLATE_DATABASE = 'contentops_template'

/** Where the throwaway server listens; passed from Vitest globalSetup to test files. */
export interface PostgresInfo {
  host: string
  port: number
  superUser: string
  superPassword: string
  containerId: string
}

export type DbRole = 'super' | 'migrate' | 'app'

/** Test passwords of the two roles; real ones come from `.env` on the host. */
const ROLE_PASSWORD: Record<Exclude<DbRole, 'super'>, string> = {
  migrate: 'migrate-test',
  app: 'app-test',
}

export function databaseUrl(info: PostgresInfo, database: string, role: DbRole = 'app'): string {
  const [user, password] =
    role === 'super'
      ? [info.superUser, info.superPassword]
      : [role === 'migrate' ? MIGRATE_ROLE : APP_ROLE, ROLE_PASSWORD[role]]
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${info.host}:${info.port}/${database}`
}

/**
 * Starts one PostgreSQL 18 container and creates the two roles the way the host script
 * does: `contentops_migrate` owns the databases, `contentops_app` only logs in.
 */
export async function startPostgres(): Promise<{
  info: PostgresInfo
  container: StartedPostgreSqlContainer
}> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('postgres')
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'max_connections=300',
    ])
    .start()
  const info: PostgresInfo = {
    host: container.getHost(),
    port: container.getPort(),
    superUser: container.getUsername(),
    superPassword: container.getPassword(),
    containerId: container.getId(),
  }
  await withClient(databaseUrl(info, 'postgres', 'super'), async (client) => {
    await client.query(`CREATE ROLE ${MIGRATE_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD.migrate}'`)
    await client.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${ROLE_PASSWORD.app}'`)
  })
  return { info, container }
}

/** Creates a database owned by the migrate role, empty or as a copy of a template. */
export async function createDatabase(
  info: PostgresInfo,
  name: string,
  options: { template?: string } = {},
): Promise<void> {
  const template = options.template ?? 'template0'
  await withClient(databaseUrl(info, 'postgres', 'super'), (client) =>
    client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}" OWNER ${MIGRATE_ROLE}`),
  )
}

export async function dropDatabase(info: PostgresInfo, name: string): Promise<void> {
  await withClient(databaseUrl(info, 'postgres', 'super'), (client) =>
    client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  )
}

/**
 * Schema-only dump made by pg_dump inside the container (same version as the server),
 * normalised: no comments, session settings or the random `\restrict` key.
 */
export async function dumpSchema(info: PostgresInfo, database: string): Promise<string> {
  const { stdout } = await run(
    'docker',
    [
      'exec',
      info.containerId,
      'pg_dump',
      '--username',
      info.superUser,
      '--schema-only',
      '--restrict-key=golden',
      database,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  )
  return normaliseDump(stdout)
}

export function normaliseDump(dump: string): string {
  const lines = dump
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('--') &&
        !line.startsWith('SET ') &&
        !line.startsWith('SELECT pg_catalog.set_config') &&
        !line.startsWith('\\restrict') &&
        !line.startsWith('\\unrestrict'),
    )
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

export async function withClient<T>(
  url: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
