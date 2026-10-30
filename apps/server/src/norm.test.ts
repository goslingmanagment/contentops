import { ConflictDetailsSchema } from '@contentops/contracts/domain/errors'
import { JournalEventSchema } from '@contentops/contracts/domain/journal'
import { WeekNormSchema } from '@contentops/contracts/domain/plan'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addPerson,
  call,
  newKey,
  OWNER,
  signIn,
  type TestServer,
  testServer,
} from './testing/server'

/**
 * The first real path (PLAN 1а, SPEC §11.2): `PUT /api/v1/{model}/accounts/{account}/week-norm`
 * under concurrent changes, concurrent repeats, a lost answer and a repeat after the access
 * was revoked.
 */

const URL = '/api/v1/lora/accounts/lora-1/week-norm'

function norm(fypDays: number[], time = '03:00') {
  const perDay = [0, 0, 0, 0, 0, 0, 0].map((_, day) => (fypDays.includes(day) ? 1 : 0))
  return {
    cells: [
      { kind: 'fyp', per_day: perDay, time },
      { kind: 'wall', per_day: [1, 1, 1, 1, 1, 1, 1], time: '20:00' },
      { kind: 'life_vault', per_day: [0, 1, 0, 0, 0, 0, 0], time: null },
    ],
    release: null,
    usual_assignee: null,
    uniq_level: 'soft',
  }
}

let server: TestServer
let owner: string

async function version(): Promise<number> {
  const response = await call(server.app, { method: 'GET', url: URL, as: owner })
  return WeekNormSchema.parse(response.json()).version
}

async function journalRows(requestId?: string) {
  const { rows } = await server.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM action_log
     WHERE action = 'plan.updateNorm' AND entry_kind = 'action' AND result = 'ok'
       AND (${requestId ?? null}::text IS NULL OR request_id = ${requestId ?? null})`)
  return rows[0]?.n ?? 0
}

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
})
afterAll(() => server.close())

describe('PUT week-norm', () => {
  it('reads an empty norm at version 1 with its ETag', async () => {
    const response = await call(server.app, { method: 'GET', url: URL, as: owner })
    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toBe('"1"')
    const body = WeekNormSchema.parse(response.json())
    expect(body.cells.map((cell) => cell.kind)).toEqual(['fyp', 'wall', 'life_vault'])
  })

  it('needs If-Match (428) and refuses a stale one (412 with who changed it)', async () => {
    const missing = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key: newKey(),
      body: norm([1]),
    })
    expect(missing.statusCode).toBe(428)
    const stale = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key: newKey(),
      ifMatch: 99,
      body: norm([1]),
    })
    expect(stale.statusCode).toBe(412)
    expect(stale.json().code).toBe('version_mismatch')
    const details = ConflictDetailsSchema.parse(stale.json().details)
    expect(details.current_version).toBe(await version())
  })

  it('concurrent changes: one wins, the other gets 412', async () => {
    const current = await version()
    const [left, right] = await Promise.all(
      [norm([0]), norm([2])].map((body) =>
        call(server.app, {
          method: 'PUT',
          url: URL,
          as: owner,
          key: newKey(),
          ifMatch: current,
          body,
        }),
      ),
    )
    const statuses = [left?.statusCode, right?.statusCode].sort()
    expect(statuses).toEqual([200, 412])
    const winner = [left, right].find((response) => response?.statusCode === 200)
    expect(winner?.headers.etag).toBe(`"${current + 1}"`)
    expect(await version()).toBe(current + 1)
  })

  it('concurrent repeats with one key run once and give both the same answer', async () => {
    const current = await version()
    const before = await journalRows()
    const key = newKey()
    const request = {
      method: 'PUT' as const,
      url: URL,
      as: owner,
      key,
      ifMatch: current,
      body: norm([3]),
    }
    const responses = await Promise.all([call(server.app, request), call(server.app, request)])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(responses[0]?.json()).toEqual(responses[1]?.json())
    expect(await version()).toBe(current + 1)
    expect(await journalRows()).toBe(before + 1)
  })

  it('a lost answer: the repeat returns the saved one, no second journal row', async () => {
    const current = await version()
    const key = newKey()
    const request = {
      method: 'PUT' as const,
      url: URL,
      as: owner,
      key,
      ifMatch: current,
      body: norm([4], '04:00'),
    }
    const first = await call(server.app, request)
    expect(first.statusCode).toBe(200)
    const requestId = String(first.headers['x-request-id'])
    expect(await journalRows(requestId)).toBe(1)
    const before = await journalRows()
    // The version moved on, but the saved answer comes before `If-Match` (SPEC §11.2).
    const repeat = await call(server.app, request)
    expect(repeat.statusCode).toBe(200)
    expect(repeat.json()).toEqual(first.json())
    expect(repeat.headers.etag).toBe(first.headers.etag)
    expect(await journalRows()).toBe(before)
    expect(await version()).toBe(current + 1)
  })

  it('the same key with another request is a 409 conflict', async () => {
    const current = await version()
    const key = newKey()
    const ok = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key,
      ifMatch: current,
      body: norm([5]),
    })
    expect(ok.statusCode).toBe(200)
    const other = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key,
      ifMatch: current,
      body: norm([6]),
    })
    expect(other.statusCode).toBe(409)
    expect(other.json().code).toBe('idempotency_conflict')
  })

  it('a rolled-back command frees its key', async () => {
    const key = newKey()
    const stale = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key,
      ifMatch: 999,
      body: norm([0, 6]),
    })
    expect(stale.statusCode).toBe(412)
    const retry = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key,
      ifMatch: await version(),
      body: norm([0, 6]),
    })
    expect(retry.statusCode).toBe(200)
  })

  it('a repeat after the access was revoked is refused, not answered from the store', async () => {
    const diana = await addPerson(server.app, owner, {
      name: 'Диана',
      login: 'diana',
      role: 'manager',
      models: ['lora'],
    })
    const request = {
      method: 'PUT' as const,
      url: URL,
      as: diana.session,
      key: newKey(),
      ifMatch: await version(),
      body: norm([1, 2]),
    }
    expect((await call(server.app, request)).statusCode).toBe(200)

    // The owner takes Lora away: the grant ends at once, the saved answer stays unseen.
    const person = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/people',
      as: owner,
    })
    const dianaRow = person.json().items.find((p: { login: string }) => p.login === 'diana')
    const rights = await call(server.app, {
      method: 'PATCH',
      url: `/api/v1/admin/people/${diana.id}`,
      as: owner,
      key: newKey(),
      ifMatch: dianaRow.version,
      body: { models: [] },
    })
    expect(rights.statusCode).toBe(200)
    const afterGrant = await call(server.app, request)
    expect(afterGrant.statusCode).toBe(403)

    // Access revoked entirely: the session no longer exists.
    const revoke = await call(server.app, {
      method: 'POST',
      url: `/api/v1/admin/people/${diana.id}:revoke-access`,
      as: owner,
      key: newKey(),
    })
    expect(revoke.statusCode).toBe(200)
    const afterRevoke = await call(server.app, request)
    expect(afterRevoke.statusCode).toBe(401)
  })

  it('writes the change to the journal with the request id and «было → стало»', async () => {
    const current = await version()
    const response = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key: newKey(),
      ifMatch: current,
      body: norm([1, 3, 5, 6]),
    })
    expect(response.statusCode).toBe(200)
    const journal = await call(server.app, {
      method: 'GET',
      url: '/api/v1/lora/journal?area=plan&limit=1',
      as: owner,
    })
    expect(journal.statusCode).toBe(200)
    const [event] = journal.json().items.map((item: unknown) => JournalEventSchema.parse(item))
    expect(event?.request_id).toBe(response.headers['x-request-id'])
    expect(event?.phrase).toBe('Дмитрий изменил норму Fansly 1')
    expect(event?.actor).toMatchObject({ type: 'person', name: 'Дмитрий', gender: 'm' })
    expect(event?.changes).toContainEqual({ field: 'Фуп · сб', before: '—', after: '1' })
  })

  it('writes a refused change after the rollback', async () => {
    const response = await call(server.app, {
      method: 'PUT',
      url: URL,
      as: owner,
      key: newKey(),
      ifMatch: 1,
      body: norm([0]),
    })
    expect(response.statusCode).toBe(412)
    const { rows } = await server.db.execute<{ result: string; model: string | null }>(sql`
      SELECT result, model_id::text AS model FROM action_log
       WHERE request_id = ${String(response.headers['x-request-id'])}`)
    expect(rows).toEqual([{ result: 'error', model: expect.any(String) }])
  })
})
