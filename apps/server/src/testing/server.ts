import { bootstrap, createDb, createPool, type Db } from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { createLogger } from '../logger'
import { buildServer } from '../server'
import type { IntegrationSecrets } from '../services'

export const OWNER = { login: 'dmitriy', password: 'owner-password-1' }

/** Two models with pages, as bootstrap makes them; no thresholds, no switches. */
export const BOOTSTRAP = {
  models: [
    {
      code: 'lora',
      title: 'Лора',
      title_genitive: 'Лоры',
      accounts: [
        { code: 'lora-1', platform: 'fansly', title: 'Fansly 1', handle: 'LoraVie' },
        { code: 'lora-of', platform: 'onlyfans', title: 'OF Free', handle: 'loravie' },
      ],
      id_counters: counters(),
    },
    {
      code: 'ari',
      title: 'Ари',
      title_genitive: 'Ари',
      accounts: [{ code: 'ari-1', platform: 'fansly', title: 'Fansly 1', handle: 'itsaribae' }],
      id_counters: counters(),
    },
  ],
  owner: { login: OWNER.login, display_name: 'Дмитрий', gender: 'm' },
}

function counters() {
  const types = ['PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM']
  return Object.fromEntries(types.map((type) => [type, { next_number: 1, legacy: false }]))
}

const NO_SECRETS: IntegrationSecrets = { ydisk: false, dropbox: false, hub: false }

export interface TestServer {
  app: ReturnType<typeof buildServer>
  db: Db
  database: TestDatabase
  close(): Promise<void>
}

/** The `web` role on a fresh database of its own, after bootstrap. */
export async function testServer(
  options: { secrets?: IntegrationSecrets } = {},
): Promise<TestServer> {
  const database = await createTestDatabase()
  const pool = createPool(database.url(), { max: 20 })
  const db = createDb(pool)
  await bootstrap(db, BOOTSTRAP, { env: { CONTENTOPS_OWNER_PASSWORD: OWNER.password } })
  const app = buildServer({
    db,
    publicUrl: 'http://localhost:5173',
    secrets: options.secrets ?? NO_SECRETS,
    logger: createLogger({ level: process.env.TEST_LOG === '1' ? 'error' : 'silent' }),
  })
  await app.ready()
  return {
    app,
    db,
    database,
    close: async () => {
      await app.close()
      await pool.end()
      await database.drop()
    },
  }
}

export interface Call {
  method: InjectOptions['method']
  url: string
  /** Session cookie value or `Bearer …`. */
  as?: string | null
  key?: string
  ifMatch?: number
  body?: unknown
}

export function call(app: TestServer['app'], request: Call): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {}
  if (request.as?.startsWith('Bearer ')) headers.authorization = request.as
  else if (request.as) headers.cookie = `co_session=${request.as}`
  if (request.key) headers['idempotency-key'] = request.key
  if (request.ifMatch !== undefined) headers['if-match'] = `"${request.ifMatch}"`
  return app.inject({
    method: request.method,
    url: request.url,
    headers,
    ...(request.body === undefined ? {} : { payload: request.body as object }),
  })
}

/** Signs in and gives the session cookie value. */
export async function signIn(
  app: TestServer['app'],
  login: string,
  password: string,
): Promise<string> {
  const response = await call(app, {
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    body: { login, password },
  })
  if (response.statusCode !== 200) throw new Error(`sign-in ${login}: ${response.body}`)
  const cookie = String(response.headers['set-cookie'])
  const token = /co_session=([^;]+)/.exec(cookie)?.[1]
  if (!token) throw new Error('no session cookie')
  return token
}

let keys = 0
export const newKey = () => `test-key-${++keys}-${Date.now()}`

/** Adds a person as the owner and signs them in with the temporary password. */
export async function addPerson(
  app: TestServer['app'],
  owner: string,
  person: { name: string; login: string; role: 'owner' | 'manager' | 'reader'; models: string[] },
): Promise<{ id: string; session: string; password: string }> {
  const response = await call(app, {
    method: 'POST',
    url: '/api/v1/admin/people',
    as: owner,
    key: newKey(),
    body: person,
  })
  if (response.statusCode !== 201) throw new Error(`add person: ${response.body}`)
  const created = response.json() as { person: { id: string }; temporary_password: string }
  const session = await signIn(app, person.login, created.temporary_password)
  return { id: created.person.id, session, password: created.temporary_password }
}
