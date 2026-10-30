import { buildPath } from '@contentops/contracts/api/route'
import { describe, expect, it } from 'vitest'
import { pathParamNames, tableRoutes, toFastifyPath } from './routes'
import { testApp } from './test-app'

describe('toFastifyPath', () => {
  it('turns template parameters into Fastify parameters', () => {
    expect(toFastifyPath('/api/v1/{model}/i/{id}')).toBe('/api/v1/:model/i/:id')
  })

  it('keeps a verb suffix literal and fences the parameter before it', () => {
    expect(toFastifyPath('/api/v1/{model}/i/{id}:upload-now')).toBe(
      '/api/v1/:model/i/:id(^[^:/]+)::upload-now',
    )
    expect(toFastifyPath('/api/v1/{model}/orders/{order}/revisions/{revision}:reopen')).toBe(
      '/api/v1/:model/orders/:order/revisions/:revision(^[^:/]+)::reopen',
    )
  })

  it('escapes a verb after a static segment', () => {
    expect(toFastifyPath('/api/v1/{model}/not-uploaded:mark')).toBe(
      '/api/v1/:model/not-uploaded::mark',
    )
  })
})

/** Records which table routes and params Fastify matched for each request. */
function routingApp() {
  const { app } = testApp()
  const seen: { routes: string[]; params: unknown }[] = []
  app.addHook('onRequest', async (request) => {
    seen.push({ routes: request.routeOptions.config.routes ?? [], params: request.params })
  })
  return { app, seen }
}

describe('routing on the real table', () => {
  it.each([
    ['POST', '/api/v1/lora/i/PPV-073:upload-now', 'objects.uploadNow', { id: 'PPV-073' }],
    ['POST', '/api/v1/lora/i/PPV-073:make-ppv', 'objects.makePpv', { id: 'PPV-073' }],
    ['POST', '/api/v1/lora/i/PPV-073/files:reorder', 'objectFiles.reorder', { id: 'PPV-073' }],
    [
      'POST',
      '/api/v1/lora/i/PPV-073/links/L-1:confirm',
      'objects.confirmLink',
      { id: 'PPV-073', link: 'L-1' },
    ],
    [
      'POST',
      '/api/v1/lora/orders/C-4/revisions/2:reopen',
      'orders.reopenRevision',
      { order: 'C-4', revision: '2' },
    ],
    ['POST', '/api/v1/lora/plan/rows:mark', 'plan.markMany', {}],
    ['POST', '/api/v1/lora/plan/rows/R-9:mark', 'plan.mark', { row: 'R-9' }],
    ['POST', '/api/v1/lora/plan/rows/R-9:mark-confirm', 'plan.markConfirm', { row: 'R-9' }],
    ['POST', '/api/v1/lora/not-uploaded:mark', 'objects.alreadyUploaded', {}],
    ['DELETE', '/api/v1/lora/i/PPV-073', 'objects.remove', { id: 'PPV-073' }],
    ['GET', '/api/v1/lora/people', 'settings.modelPeople', {}],
  ] as const)('%s %s → %s', async (method, url, key, params) => {
    const { app, seen } = routingApp()
    await app.inject({ method, url })
    expect(seen[0]?.routes).toEqual([key])
    expect(seen[0]?.params).toEqual({ model: 'lora', ...params })
  })

  it('keeps admin paths apart from model paths', async () => {
    const { app, seen } = routingApp()
    await app.inject({ method: 'GET', url: '/api/v1/admin/people' })
    expect(seen[0]?.routes).toEqual(['admin.people'])
    expect(seen[0]?.params).toEqual({})
  })

  it('registers every route of the table and answers 501 without a handler', async () => {
    const { app, seen } = routingApp()
    for (const { key, route } of tableRoutes()) {
      const params = Object.fromEntries(
        pathParamNames(route.path).map((name) => [name, `${name}-1`]),
      )
      const response = await app.inject({
        method: route.method,
        url: buildPath(route.path, params),
      })
      expect(response.statusCode, key).not.toBe(404)
      expect(seen.at(-1)?.routes, key).toContain(key)
      expect(seen.at(-1)?.params, key).toEqual(params)
    }
  })
})
