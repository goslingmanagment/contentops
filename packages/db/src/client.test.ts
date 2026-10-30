import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createPool } from './client.ts'
import { createTestDatabase, type TestDatabase } from './testing/index.ts'

let database: TestDatabase

beforeAll(async () => {
  database = await createTestDatabase()
})
afterAll(() => database?.drop())

it('keeps the process alive when an idle connection is terminated', async () => {
  const lost: Error[] = []
  const pool = createPool(database.url(), { max: 1, onIdleError: (error) => lost.push(error) })
  const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const admin = new pg.Client({ connectionString: database.url('super') })
  await admin.connect()
  await admin.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid])
  await admin.end()
  await expect.poll(() => lost.length).toBe(1)
  // The pool replaced the dead connection and keeps answering.
  const again = await pool.query<{ one: number }>('SELECT 1 AS one')
  expect(again.rows[0]?.one).toBe(1)
  await pool.end()
})
