import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { originRefusal } from './origin-check'
import { OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * A change made by a browser is taken only from a page of ContentOps itself (origin-check.ts): another site's page
 * cannot sign a person out, sign someone in, or upload; an agent's bearer and a script are not asked.
 */

const PUBLIC = 'contentops.example.test'
const EVIL = 'https://evil.example'

describe('originRefusal', () => {
  const allowed = ['http://localhost:5173']
  const post = (headers: Record<string, string>, hostname = PUBLIC) =>
    originRefusal({ method: 'POST', headers, hostname }, allowed)

  it('takes the page of its own name, any port, and a configured origin', () => {
    expect(post({ origin: `https://${PUBLIC}` })).toBeNull()
    expect(post({ origin: 'http://10.66.66.1:8088' }, '10.66.66.1')).toBeNull()
    expect(post({ origin: 'http://localhost:5173' }, 'web')).toBeNull()
  })

  it('refuses another site, `null` and a cross-site fetch without an origin', () => {
    expect(post({ origin: EVIL })?.code).toBe('forbidden')
    expect(post({ origin: `https://${PUBLIC}.evil.example` })?.code).toBe('forbidden')
    expect(post({ origin: 'null' })?.code).toBe('forbidden')
    expect(post({ 'sec-fetch-site': 'cross-site' })?.code).toBe('forbidden')
    expect(post({ 'sec-fetch-site': 'same-site' })?.code).toBe('forbidden')
  })

  it('never asks a read, a bearer or a request that is not a browser’s', () => {
    expect(
      originRefusal({ method: 'GET', headers: { origin: EVIL }, hostname: PUBLIC }, allowed),
    ).toBeNull()
    expect(post({ origin: EVIL, authorization: 'Bearer co_x' })).toBeNull()
    expect(post({})).toBeNull()
    expect(post({ 'sec-fetch-site': 'same-origin' })).toBeNull()
  })
})

describe('a change from another site’s page, through the server', () => {
  let server: TestServer
  beforeAll(async () => {
    server = await testServer()
  })
  afterAll(() => server.close())

  const me = (session: string) =>
    server.app.inject({
      method: 'GET',
      url: '/api/v1/admin/me',
      headers: { host: PUBLIC, cookie: `co_session=${session}` },
    })

  it('cannot sign the person out, sign someone in or start an upload; the person’s own page can', async () => {
    const session = await signIn(server.app, OWNER.login, OWNER.password)
    const cookie = `co_session=${session}`
    const foreign = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { host: PUBLIC, cookie, origin: EVIL },
    })
    expect(foreign.statusCode).toBe(403)
    expect(foreign.json().code).toBe('forbidden')
    expect((await me(session)).statusCode).toBe(200)

    const forged = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { host: PUBLIC, origin: EVIL },
      payload: { login: OWNER.login, password: OWNER.password },
    })
    expect(forged.statusCode).toBe(403)
    expect(forged.headers['set-cookie']).toBeUndefined()

    const upload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads/tus',
      headers: { host: PUBLIC, cookie, origin: EVIL, 'tus-resumable': '1.0.0' },
    })
    expect(upload.statusCode).toBe(403)

    const own = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { host: PUBLIC, cookie, origin: `https://${PUBLIC}` },
    })
    expect(own.statusCode).toBe(200)
    expect((await me(session)).statusCode).toBe(401)
  })

  it('leaves an agent’s bearer and a script without Origin as they were', async () => {
    const bearer = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { host: PUBLIC, origin: EVIL, authorization: 'Bearer co_unknown' },
    })
    expect(bearer.statusCode).not.toBe(403)
    const script = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { host: PUBLIC },
      payload: { login: OWNER.login, password: OWNER.password },
    })
    expect(script.statusCode).toBe(200)
  })
})
