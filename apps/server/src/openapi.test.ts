import { describe, expect, it } from 'vitest'
import { openApiDocument } from './app'
import { tableRoutes } from './routes'
import { testApp } from './test-app'

interface Operation {
  operationId: string
  parameters?: { in: string; name: string }[]
}
type Document = { paths: Record<string, Record<string, Operation>> }

describe('openapi.json', () => {
  it('describes every route of the table at its own path', async () => {
    const document = (await openApiDocument()) as Document
    for (const { key, route } of tableRoutes()) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()]
      expect(operation?.operationId, key).toContain(key)
      const shape = 'shape' in route.query ? Object.keys(route.query.shape as object) : []
      const names = (operation?.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name)
      expect(names, key).toEqual(expect.arrayContaining(shape))
    }
  })

  it('is served at /api/v1/openapi.json', async () => {
    const { app } = testApp()
    const response = await app.inject({ url: '/api/v1/openapi.json' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(await openApiDocument())
  })
})
