import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const BIN = fileURLToPath(new URL('../bin/contentops.mjs', import.meta.url))

/** The shim loads the TypeScript sources of the workspace with plain `node`, no build. */
it('runs from the sources with node', () => {
  const routes = spawnSync(process.execPath, [BIN, 'routes', '--json'], { encoding: 'utf8' })
  expect(routes.status, routes.stderr).toBe(0)
  expect(JSON.parse(routes.stdout).routes).toContainEqual(
    expect.objectContaining({ route: 'plan.updateNorm', method: 'PUT' }),
  )
  const usage = spawnSync(process.execPath, [BIN, 'objects', 'get', '--model', 'lora'], {
    encoding: 'utf8',
  })
  expect(usage.status).toBe(64)
  expect(usage.stdout).toBe('')
  expect(usage.stderr).toContain('usage: objects.get needs --id')
})
