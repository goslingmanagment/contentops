import { createDb, createPool, type Db } from '@contentops/db'
import { createTestDatabase, type TestDatabase } from '@contentops/db/testing'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleOf, type MembershipRow } from './detail'
import { handleSql } from './ids'

/**
 * A handle SQL writes or answers — the composition of a delivery, «Похоже на фото № 111 из
 * SET-015», the file a duplicate repeats — is the handle the screens and the API resolve. `lpad`
 * cut `pic111` to `pic11`, the handle of another file (catalog check of 05.11.2026).
 */

let database: TestDatabase
let pool: ReturnType<typeof createPool>
let db: Db

beforeAll(async () => {
  database = await createTestDatabase()
  pool = createPool(database.url(), { max: 2 })
  db = createDb(pool)
})
afterAll(async () => {
  await pool?.end()
  await database?.drop()
})

describe('handleSql', () => {
  it('spells every file as handleOf does, ordinals past 99 whole', async () => {
    const files: { role: MembershipRow['role']; ordinal: number | null; variant: number }[] = [
      ...(['master', 'teaser', 'thumb', 'cap'] as const).map((role) => ({
        role,
        ordinal: null,
        variant: 0,
      })),
      ...(['pic', 'raw', 'ed', 'clip'] as const).flatMap((role) =>
        Array.from({ length: 999 }, (_, i) => ({ role, ordinal: i + 1, variant: 0 })),
      ),
      { role: 'master', ordinal: null, variant: 1 },
      { role: 'master', ordinal: null, variant: 12 },
    ]
    const { rows } = await db.execute<{ handle: string }>(sql`
      SELECT ${handleSql('m')} AS handle
        FROM unnest(${sql.param(files.map((file) => file.role))}::text[],
                    ${sql.param(files.map((file) => file.ordinal))}::int[],
                    ${sql.param(files.map((file) => file.variant))}::int[])
             WITH ORDINALITY AS m(role, ordinal, variant_no, n)
       ORDER BY m.n`)
    const handles = rows.map((row) => row.handle)
    expect(handles).toEqual(files.map((file) => handleOf(file.role, file.ordinal, file.variant)))
    expect(handles).toEqual(expect.arrayContaining(['pic07', 'pic11', 'pic111', 'raw999', 'u12']))
    expect(new Set(handles).size).toBe(handles.length)
  })
})
