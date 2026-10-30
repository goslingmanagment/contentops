import { IntegrationViewSchema } from '@contentops/contracts/api/responses'
import { ThresholdSchema } from '@contentops/contracts/domain/system'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, newKey, OWNER, signIn, type TestServer, testServer } from './testing/server'

/**
 * PLAN 1а: the base scenario «всё выключено» — every switch off and no integration secret in
 * the environment. Steps are added as functions arrive (2а–2в, 4а: upload, accept, find,
 * download, put in the plan, mark by hand); the whole path passes when stage 4 closes.
 */

let server: TestServer
let owner: string

beforeAll(async () => {
  server = await testServer({ secrets: { ydisk: false, dropbox: false, hub: false } })
})
afterAll(() => server.close())

describe('«всё выключено»', () => {
  it('starts green without secrets', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('signs in', async () => {
    owner = await signIn(server.app, OWNER.login, OWNER.password)
    expect(owner).toBeTruthy()
  })

  it('shows every integration off or not set up, none working', async () => {
    const response = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/integrations',
      as: owner,
    })
    expect(response.statusCode).toBe(200)
    const items = response.json().items.map((item: unknown) => IntegrationViewSchema.parse(item))
    const states = Object.fromEntries(
      items.map((item: { id: string; state: string }) => [item.id, item.state]),
    )
    expect(states).toMatchObject({
      'ydisk.lora': 'unset',
      'hub.lora-1': 'unset',
      ai: 'unset',
      fyper: 'off',
      agents: 'off',
    })
    expect(Object.values(states)).not.toContain('working')
  })

  it('opens the settings: people, models, thresholds without values', async () => {
    for (const url of ['/api/v1/admin/people', '/api/v1/admin/models', '/api/v1/admin/agents']) {
      expect((await call(server.app, { method: 'GET', url, as: owner })).statusCode).toBe(200)
    }
    const thresholds = await call(server.app, {
      method: 'GET',
      url: '/api/v1/admin/thresholds',
      as: owner,
    })
    const values = thresholds.json().items.map((item: unknown) => ThresholdSchema.parse(item).value)
    expect(values.every((value: number | null) => value === null)).toBe(true)
  })

  it('changes the week norm', async () => {
    const url = '/api/v1/lora/accounts/lora-of/week-norm'
    const norm = await call(server.app, { method: 'GET', url, as: owner })
    const { account: _account, version, ...body } = norm.json()
    const response = await call(server.app, {
      method: 'PUT',
      url,
      as: owner,
      key: newKey(),
      ifMatch: version,
      body: { ...body, release: { every_weeks: 2, weekday: 3, time: '20:00' } },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().version).toBe(version + 1)
  })
})
