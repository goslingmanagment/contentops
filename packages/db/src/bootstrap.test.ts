import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verify } from '@node-rs/argon2'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BootstrapConfigSchema, BootstrapError, bootstrap } from './bootstrap.ts'
import { createDb, createPool, type Db } from './client.ts'
import { PACKAGE_DIR } from './testing/generated.ts'
import { createTestDatabase } from './testing/index.ts'

const PASSWORD = 'correct horse battery staple'
let example: unknown
let pool: pg.Pool
let db: Db

beforeAll(async () => {
  example = JSON.parse(await readFile(join(PACKAGE_DIR, 'bootstrap.example.json'), 'utf8'))
  pool = createPool((await createTestDatabase()).url('app'), { max: 2 })
  db = createDb(pool)
})
afterAll(() => pool?.end())

async function counts() {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM models)::int AS models,
    (SELECT count(*) FROM accounts)::int AS accounts,
    (SELECT count(*) FROM surfaces)::int AS surfaces,
    (SELECT count(*) FROM promo_channels)::int AS promo_channels,
    (SELECT count(*) FROM id_counters)::int AS id_counters,
    (SELECT count(*) FROM principals)::int AS principals,
    (SELECT count(*) FROM principal_grants)::int AS grants,
    (SELECT count(*) FROM policy_settings)::int AS settings,
    (SELECT count(*) FROM action_log)::int AS log`)
  return rows[0]
}

describe('bootstrap', () => {
  it('the example configuration is valid', () => {
    const config = BootstrapConfigSchema.parse(example)
    expect(config.models.map((m) => m.code)).toEqual(['lora', 'lilly', 'ari'])
    const lora = config.models[0]
    expect(lora?.accounts.find((a) => a.code === 'lora-of')?.surfaces.map((s) => s.kind)).toEqual([
      'wall',
      'story',
      'vault',
      'mass_dm',
    ])
  })

  it('needs the owner password from the environment', async () => {
    await expect(bootstrap(db, example, { env: {} })).rejects.toBeInstanceOf(BootstrapError)
    expect((await counts()).models).toBe(0)
  })

  it('creates everything once; the second run changes nothing and says so', async () => {
    const lines: string[] = []
    const first = await bootstrap(db, example, {
      env: { CONTENTOPS_OWNER_PASSWORD: PASSWORD },
      log: (line) => lines.push(line),
    })
    expect(first.created).toContain('owner dmitriy')
    expect(first.created).toContain('model lora')
    expect(first.created).toContain('surface lora-1/fyp')
    expect(first.created).toContain('grant dmitriy → ari')
    const after = await counts()
    expect(after).toMatchObject({
      models: 3,
      accounts: 9,
      surfaces: 5 * 7 + 4 * 2,
      promo_channels: 6,
      id_counters: 8 * 3,
      principals: 1,
      grants: 3,
      settings: 0,
    })

    const second: string[] = []
    const again = await bootstrap(db, example, { env: {}, log: (line) => second.push(line) })
    expect(again.created).toEqual([])
    expect(second).toEqual(['bootstrap: nothing to do, everything is in place'])
    expect(await counts()).toEqual(after)
  })

  it('stores the counters, the legacy marks and the owner as configured', async () => {
    const { rows: counters } = await pool.query(`
      SELECT m.code, c.type, c.next_number, c.legacy_reserved_at IS NOT NULL AS reserved
        FROM id_counters c JOIN models m ON m.id = c.model_id
       WHERE m.code = 'ari' ORDER BY c.type`)
    expect(counters.filter((c) => c.reserved).map((c) => c.type)).toEqual(['PRM', 'SXT'])
    expect(counters.every((c) => c.next_number === 1)).toBe(true)

    const { rows } = await pool.query(
      "SELECT kind, role, gender, password_hash FROM principals WHERE login = 'dmitriy'",
    )
    expect(rows[0]).toMatchObject({ kind: 'human', role: 'owner', gender: 'm' })
    expect(await verify(rows[0].password_hash, PASSWORD)).toBe(true)

    const { rows: log } = await pool.query(
      "SELECT actor_type, actor_label, action, entry_kind, before, after FROM action_log WHERE action <> 'bootstrap' OR entry_kind = 'action'",
    )
    expect(log.map((row) => row.action).sort()).toEqual(['bootstrap', 'principal.create'])
    const text = JSON.stringify(await pool.query('SELECT * FROM action_log').then((r) => r.rows))
    expect(text).not.toContain(rows[0].password_hash)
    expect(text).not.toContain('argon2')
    expect(text).not.toContain(PASSWORD)
  })

  it('rejects a configuration that contradicts itself', () => {
    const broken = structuredClone(example) as { models: Array<{ accounts: unknown[] }> }
    broken.models[1]?.accounts.push({
      code: 'lora-1',
      platform: 'fansly',
      title: 'dup',
      handle: 'dup',
      surfaces: [{ kind: 'story', auto_match: true }],
    })
    const result = BootstrapConfigSchema.safeParse(broken)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'account lora-1 twice',
        'lora-1: story cannot be matched automatically',
      ]),
    )
  })
})
