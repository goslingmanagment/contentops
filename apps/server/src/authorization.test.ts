import { buildPath, type Route } from '@contentops/contracts/api/route'
import { ApiErrorBodySchema } from '@contentops/contracts/domain/errors'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accessOf } from './access'
import type { HandlerRegistry } from './handlers'
import { createHandlers } from './handlers/index'
import { pathParamNames, tableRoutes } from './routes'
import type { Services } from './services'
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
 * SPEC §11.1, §12.0 «Тесты»: every route of the table, those the server does not answer yet
 * included, is refused to a caller without rights before anything else happens.
 */

const ROUTES = tableRoutes()
const SOME_ID = '01a1b2c3-0000-7000-8000-000000000000'

function urlOf(route: Route, model: string): string {
  const params = Object.fromEntries(
    pathParamNames(route.path).map((name) => [name, name === 'model' ? model : SOME_ID]),
  )
  return buildPath(route.path, params as never)
}

const underModel = ROUTES.filter(({ route }) => route.path.includes('{model}'))
const changing = ROUTES.filter(({ route }) => route.method !== 'GET')
/** A person's own profile and sessions: «только чтение» changes them too. */
const SELF = new Set([
  'auth.signOutEverywhere',
  'settings.updateProfile',
  'settings.changePassword',
  'settings.revokeMySession',
])

const handlers = createHandlers({} as Services) as Record<string, Record<string, unknown>>
const unanswered = ROUTES.filter(({ area, name }) => !handlers[area]?.[name])

let server: TestServer
let owner: string
let foreignManager: string
let reader: string

beforeAll(async () => {
  server = await testServer()
  owner = await signIn(server.app, OWNER.login, OWNER.password)
  foreignManager = (
    await addPerson(server.app, owner, {
      name: 'Аня',
      login: 'anya',
      role: 'manager',
      models: ['ari'],
    })
  ).session
  reader = (
    await addPerson(server.app, owner, {
      name: 'Fyper',
      login: 'fyper',
      role: 'reader',
      models: ['lora'],
    })
  ).session
})
afterAll(() => server.close())

describe('every route of the table', () => {
  it('has a known access rule', () => {
    expect(ROUTES.length).toBeGreaterThan(140)
    for (const { key, route } of ROUTES) expect(accessOf(key, route)).toBeTruthy()
  })

  it.each(ROUTES.filter(({ key }) => key !== 'auth.signIn').map((entry) => [entry.key, entry]))(
    '%s: without a session → 401',
    async (_key, { route }) => {
      const response = await call(server.app, {
        method: route.method,
        url: urlOf(route, 'lora'),
        key: newKey(),
        body: route.method === 'GET' ? undefined : {},
      })
      expect(response.statusCode).toBe(401)
      expect(ApiErrorBodySchema.parse(response.json()).code).toBe('unauthenticated')
    },
  )

  it.each(underModel.map((entry) => [entry.key, entry]))(
    '%s: a manager of another model → 403',
    async (_key, { route }) => {
      for (const model of ['lora', 'no-such-model']) {
        const response = await call(server.app, {
          method: route.method,
          url: urlOf(route, model),
          as: foreignManager,
          key: newKey(),
          body: route.method === 'GET' ? undefined : {},
        })
        expect(response.statusCode).toBe(403)
      }
    },
  )

  it.each(
    changing
      .filter(({ key }) => !SELF.has(key) && key !== 'auth.signIn')
      .map((entry) => [entry.key, entry]),
  )('%s: «только чтение» changes nothing → 403', async (_key, { route }) => {
    const response = await call(server.app, {
      method: route.method,
      url: urlOf(route, 'lora'),
      as: reader,
      key: newKey(),
      body: {},
    })
    expect(response.statusCode).toBe(403)
  })

  it.each(unanswered.map((entry) => [entry.key, entry]))(
    '%s: not answered yet — an error body and nothing else',
    async (key, { route }) => {
      const response = await call(server.app, {
        method: route.method,
        url: urlOf(route, 'lora'),
        as: owner,
        key: newKey(),
        body: route.method === 'GET' ? undefined : {},
      })
      expect([400, 501]).toContain(response.statusCode)
      const body = response.json()
      expect(
        Object.keys(body).every((field) =>
          ['code', 'message', 'details', 'request_id'].includes(field),
        ),
      ).toBe(true)
      if (response.statusCode === 501) expect(body.details).toEqual({ route: key })
    },
  )
})

describe('the handler registry', () => {
  it('answers only routes of the table', () => {
    const registry: HandlerRegistry = createHandlers({} as Services)
    const keys = new Set(ROUTES.map(({ key }) => key))
    for (const [area, routes] of Object.entries(registry)) {
      for (const name of Object.keys(routes ?? {})) expect(keys.has(`${area}.${name}`)).toBe(true)
    }
  })
})
