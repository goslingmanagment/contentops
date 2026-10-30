import type { Clock } from '@contentops/contracts/clock'
import type { ActorRef } from '@contentops/contracts/domain/common'
import type { Person } from '@contentops/contracts/domain/people'
import { applyDemoToWorld } from './demo-world'
import { PERSON, personActor } from './fixtures/people'
import { createWorld } from './fixtures/world'
import type { World } from './fixtures/world-types'
import { createOperationStore, type OperationStore } from './operations'
import type { DemoMode, MockOptions, PrototypeRole } from './options'
import { createPrototypeClock } from './prototype-clock'
import type { SampleFile } from './sample-files'

/** An answer kept under its `Idempotency-Key` to be replayed on a repeat. */
export interface StoredAnswer {
  digest: string
  status: number
  body: string
  headers: Record<string, string>
}

export interface MockState {
  world: World
  clock: Clock
  principal: Person
  actor: ActorRef
  demo: DemoMode | null
  operations: OperationStore
  idempotency: Map<string, StoredAnswer>
  mutation_times: number[]
  rate_limit: { requests: number; window_ms: number }
  latency: { min_ms: number; max_ms: number } | false
  request_counter: number
  /** After «Выйти везде» or with `?demo=signed-out`: everything but sign-in answers 401. */
  signed_out: boolean
  /** What lies behind each issued download URL (`sample-files.ts`). */
  samples: Map<string, SampleFile>
}

const PERSON_BY_ROLE: Record<PrototypeRole, string> = {
  km: PERSON.diana,
  owner: PERSON.dmitriy,
  reader: PERSON.fyper,
}

export function createMockState(options: MockOptions): MockState {
  const world = createWorld()
  applyDemoToWorld(world, options.demo)
  const clock = options.clock ?? createPrototypeClock()
  const personId = PERSON_BY_ROLE[options.role ?? 'km']
  const principal = world.people.find((person) => person.id === personId)
  if (!principal) throw new Error(`Нет человека для роли ${options.role ?? 'km'}`)
  return {
    world,
    clock,
    principal,
    actor: personActor(principal),
    demo: options.demo ?? null,
    operations: createOperationStore(clock, options.operation_ms ?? 4_000),
    idempotency: new Map(),
    mutation_times: [],
    rate_limit: options.rate_limit ?? { requests: 30, window_ms: 10_000 },
    latency: options.latency ?? { min_ms: 80, max_ms: 300 },
    request_counter: 0,
    signed_out: options.demo === 'signed-out',
    samples: new Map(),
  }
}
