import type { TestProject } from 'vitest/node'
import { ensureFixtures, type FixtureSet } from './fixtures.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    fixtures: FixtureSet
  }
}

export default async function setup(project: TestProject) {
  const started = performance.now()
  const fixtures = await ensureFixtures()
  console.info(
    `media fixtures ready in ${Math.round(performance.now() - started)} ms: ${fixtures.dir}`,
  )
  project.provide('fixtures', fixtures)
}
