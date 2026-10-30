import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiErrorBodySchema } from '@contentops/contracts/domain/errors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RequestContext } from './context'
import { ApiProblem } from './errors'
import type { HandlerRegistry } from './handlers'
import { testApp } from './test-app'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function errorOf(response: { json(): unknown; headers: Record<string, unknown> }) {
  const body = ApiErrorBodySchema.parse(response.json())
  expect(body.request_id).toBe(response.headers['x-request-id'])
  return body
}

const tag = (key: string, version: number) => ({ key, ru: null, group: null, uses: 0, version })

describe('error format', () => {
  it('answers an unknown route with 404 not_found', async () => {
    const { app } = testApp()
    const response = await app.inject({ method: 'GET', url: '/api/v1/lora/no-such-thing' })
    expect(response.statusCode).toBe(404)
    expect(errorOf(response).code).toBe('not_found')
  })

  it('answers a route without a handler with 501 not_implemented', async () => {
    const { app } = testApp()
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/tags' })
    expect(response.statusCode).toBe(501)
    const body = errorOf(response)
    expect(body.code).toBe('not_implemented')
    expect(body.details).toEqual({ route: 'admin.tags' })
  })

  it('answers a schema violation with 400 invalid_request and the issues', async () => {
    const { app } = testApp()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tags/beach',
      payload: { ru: 42 },
    })
    expect(response.statusCode).toBe(400)
    const body = errorOf(response)
    expect(body.code).toBe('invalid_request')
    expect(body.details).toMatchObject({ in: 'body', issues: [expect.stringMatching(/^ru: /)] })
    expect(body.request_id).toMatch(UUID)
  })

  it('answers a bad query of a shared path with 400', async () => {
    const { app } = testApp()
    const response = await app.inject({ method: 'GET', url: '/api/v1/lora/plan' })
    expect(response.statusCode).toBe(400)
    expect(errorOf(response).details).toMatchObject({ in: 'querystring' })
  })

  it('maps a domain refusal of a handler onto its status', async () => {
    const { app } = testApp({
      handlers: {
        admin: {
          tags: () => {
            throw new ApiProblem('version_mismatch', 'Запись уже изменили', { current_version: 4 })
          },
          people: () => {
            throw new ApiProblem('rate_limited', 'Слишком часто', undefined, 30)
          },
        },
      },
    })
    const conflict = await app.inject({ method: 'GET', url: '/api/v1/admin/tags' })
    expect(conflict.statusCode).toBe(412)
    expect(errorOf(conflict)).toMatchObject({
      code: 'version_mismatch',
      details: { current_version: 4 },
    })
    const limited = await app.inject({ method: 'GET', url: '/api/v1/admin/people' })
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBe('30')
  })

  it('hides internal failures behind 500 internal', async () => {
    const { app, lines } = testApp({
      handlers: {
        admin: {
          tags: () => {
            throw new Error('secret path /srv/content/blobs')
          },
        },
      },
    })
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/tags' })
    expect(response.statusCode).toBe(500)
    expect(errorOf(response)).toEqual({
      code: 'internal',
      message: 'Внутренняя ошибка сервера',
      request_id: response.headers['x-request-id'],
    })
    expect(response.body).not.toContain('/srv')
    expect(lines.some((line) => line.msg === 'request failed')).toBe(true)
  })

  it('treats an answer that breaks its schema as 500 internal', async () => {
    const { app } = testApp({
      handlers: { settings: { updateTag: () => ({ key: 'beach', version: 2 }) as never } },
    })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tags/beach',
      payload: {},
    })
    expect(response.statusCode).toBe(500)
    expect(errorOf(response).code).toBe('internal')
    expect(response.headers.etag).toBeUndefined()
  })

  it.each([
    ['unsupported media type', { 'content-type': 'application/xml' }, '<ru/>', 415],
    ['broken JSON', { 'content-type': 'application/json' }, '{"ru":', 400],
    ['too large a body', { 'content-type': 'application/json' }, `"${'x'.repeat(1_100_000)}"`, 413],
  ])('keeps the format for %s', async (_, headers, payload, status) => {
    const { app } = testApp()
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tags/beach',
      headers,
      payload,
    })
    expect(response.statusCode).toBe(status)
    expect(errorOf(response).code).toBe('invalid_request')
  })
})

describe('handlers', () => {
  it('get parsed input and the request context, and versioned answers carry an ETag', async () => {
    const seen: { params: unknown; body: unknown; ctx: RequestContext }[] = []
    const handlers: HandlerRegistry = {
      settings: {
        updateTag: ({ params, body, ctx }) => {
          seen.push({ params, body, ctx })
          return { ...tag(params.tag, (ctx.ifMatch ?? 0) + 1), ru: body.ru ?? null }
        },
      },
    }
    const { app } = testApp({ handlers })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tags/beach',
      headers: { 'if-match': '"3"', 'idempotency-key': 'k-1' },
      payload: { ru: ' Пляж ' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toBe('"4"')
    expect(response.json()).toEqual({ ...tag('beach', 4), ru: 'Пляж' })
    expect(seen[0]).toMatchObject({
      params: { tag: 'beach' },
      body: { ru: 'Пляж' },
      ctx: { ifMatch: 3, idempotencyKey: 'k-1', actor: null },
    })
    expect(seen[0]?.ctx.requestId).toBe(response.headers['x-request-id'])
  })

  it('answer with the success status of the route', async () => {
    const { app } = testApp({
      handlers: {
        admin: {
          issueToken: ({ params }) => ({
            token: {
              id: `${params.agent}-t1`,
              prefix: 'co_ab',
              issued_at: '2026-10-30T00:00:00Z',
              expires_at: null,
              last_used_at: null,
              revoked_at: null,
            },
            secret: 'co_abcdef',
          }),
        },
      },
    })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/agents/fyper/tokens',
      payload: { agent_id: 'fyper', expires_in_days: null },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ token: { id: 'fyper-t1' } })
  })

  it('refuse a malformed If-Match', async () => {
    const { app } = testApp({ handlers: { settings: { updateTag: () => tag('beach', 1) } } })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/tags/beach',
      headers: { 'if-match': 'yesterday' },
      payload: {},
    })
    expect(response.statusCode).toBe(400)
    expect(errorOf(response).details).toEqual({ header: 'If-Match' })
  })

  it('get the query the way the client encodes it', async () => {
    const seen: unknown[] = []
    const { app } = testApp({
      handlers: {
        objects: {
          list: ({ query }) => {
            seen.push(query)
            return { items: [], next_cursor: null }
          },
        },
      },
    })
    await app.inject({ url: '/api/v1/lora/items?where=lora-2:no&where=lora-1:yes&limit=20' })
    await app.inject({ url: '/api/v1/lora/items?tag=beach' })
    expect(seen).toEqual([{ where: ['lora-2:no', 'lora-1:yes'], limit: 20 }, { tag: ['beach'] }])
  })

  it('pick the route of a shared path by its query', async () => {
    const { app } = testApp()
    const day = await app.inject({ url: '/api/v1/lora/plan?date=2026-10-30&mine=1' })
    const week = await app.inject({ url: '/api/v1/lora/plan?week=2026-W44' })
    expect(errorOf(day).details).toEqual({ route: 'plan.day' })
    expect(errorOf(week).details).toEqual({ route: 'plan.week' })
  })
})

describe('request id', () => {
  it('is fresh for every request', async () => {
    const { app } = testApp()
    const first = await app.inject({ url: '/healthz' })
    const second = await app.inject({ url: '/healthz' })
    expect(first.headers['x-request-id']).toMatch(UUID)
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id'])
  })

  it('is taken from the local proxy only', async () => {
    const { app } = testApp()
    const headers = { 'x-request-id': 'proxy-123' }
    const local = await app.inject({ url: '/healthz', headers, remoteAddress: '127.0.0.1' })
    const outside = await app.inject({ url: '/healthz', headers, remoteAddress: '203.0.113.9' })
    expect(local.headers['x-request-id']).toBe('proxy-123')
    expect(outside.headers['x-request-id']).toMatch(UUID)
  })
})

describe('logs', () => {
  it('carry request_id on every request line, in UTC', async () => {
    const { app, lines } = testApp()
    const response = await app.inject({ url: '/api/v1/admin/tags' })
    const requestLines = lines.filter((line) => 'req' in line || 'res' in line || 'code' in line)
    expect(requestLines.length).toBeGreaterThanOrEqual(3)
    for (const line of requestLines) {
      expect(line.request_id).toBe(response.headers['x-request-id'])
      expect(line.time).toMatch(/Z$/)
    }
  })

  it('never show credentials', async () => {
    const { app, lines } = testApp()
    await app.ready()
    app.log.info({
      req: { headers: { authorization: 'Bearer co_secret', cookie: 'sid=s3' } },
      body: { password: 'hunter2' },
    })
    const text = JSON.stringify(lines)
    expect(text).not.toContain('co_secret')
    expect(text).not.toContain('s3')
    expect(text).not.toContain('hunter2')
  })
})

describe('/healthz', () => {
  let notMounted: string

  beforeAll(async () => {
    notMounted = await mkdtemp(join(tmpdir(), 'contentops-healthz-'))
  })

  afterAll(async () => {
    await rm(notMounted, { recursive: true, force: true })
  })

  it('is green when every check passes', async () => {
    const { app } = testApp({ checks: { db: async () => {} }, requireMounts: ['/'] })
    const response = await app.inject({ url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('is red with the names of failed checks', async () => {
    const { app } = testApp({
      checks: {
        db: () => {
          throw new Error('connection refused')
        },
        clock: () => true,
        queue: async () => false,
      },
    })
    const response = await app.inject({ url: '/healthz' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ ok: false, failed: ['db', 'queue'] })
  })

  it('is red while a required path is not a mount point', async () => {
    const { app } = testApp({ requireMounts: ['/', notMounted] })
    const response = await app.inject({ url: '/healthz' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ ok: false, failed: ['mounts'] })
  })
})
