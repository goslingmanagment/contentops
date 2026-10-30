import { CatalogIndexSchema } from '@contentops/contracts/domain/catalog'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { seedCatalog } from './testing/catalog-seed'
import { OWNER, signIn, type TestServer, testServer } from './testing/server'

/** The dev and pilot seed (PLAN 2а): every type, about a hundred objects, once. */

let server: TestServer

beforeAll(async () => {
  server = await testServer()
})
afterAll(() => server.close())

it('fills a believable catalog once', async () => {
  expect(await seedCatalog(server.db, 'lora')).toMatchObject({ skipped: false })
  expect(await seedCatalog(server.db, 'lora')).toEqual({ created: 0, skipped: true })
  const owner = await signIn(server.app, OWNER.login, OWNER.password)
  const response = await server.app.inject({
    method: 'GET',
    url: '/api/v1/lora/index',
    headers: { cookie: `co_session=${owner}` },
  })
  const index = CatalogIndexSchema.parse(response.json())
  expect(index.items.length).toBeGreaterThan(90)
  expect(new Set(index.items.map((entry) => entry.type)).size).toBe(8)
  const detail = await server.app.inject({
    method: 'GET',
    url: '/api/v1/lora/i/PPV-073',
    headers: { cookie: `co_session=${owner}` },
  })
  expect(detail.json().entry).toMatchObject({
    title: 'Вечеринка, блёстки, диван',
    has_teaser: true,
  })
})
