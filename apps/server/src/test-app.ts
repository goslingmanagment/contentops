import { Writable } from 'node:stream'
import { type AppDeps, buildApp } from './app'
import { createLogger } from './logger'

/** An app whose log lines are kept for the test instead of going to stdout. */
export function testApp(deps: AppDeps = {}) {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split('\n')) if (line) lines.push(JSON.parse(line))
      done()
    },
  })
  const app = buildApp({ logger: createLogger({ level: 'info', stream }), ...deps })
  return { app, lines }
}
