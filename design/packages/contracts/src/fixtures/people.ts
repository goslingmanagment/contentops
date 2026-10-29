import type { Agent } from '../domain/agents'
import type { ActorRef, Instant } from '../domain/common'
import type { Person } from '../domain/people'
import type { PersonName } from '../domain/placement'
import type { Contractor } from '../domain/promo'

/** People, agents and contractors of DESIGN §9.2. */

export const PERSON = {
  dmitriy: 'p-dmitriy',
  diana: 'p-diana',
  nikita: 'p-nikita',
  fyper: 'p-fyper',
} as const

export const AGENT = {
  intake: 'a-intake',
  orders: 'a-orders',
  import: 'a-import',
} as const

export function buildPeople(now: Instant): Person[] {
  return [
    {
      id: PERSON.dmitriy,
      name: 'Дмитрий',
      login: 'dmitriy',
      gender: 'm',
      role: 'owner',
      models: ['lora', 'lily', 'ari'],
      posts_on: [],
      sessions: 2,
      last_seen_at: now,
      version: 1,
    },
    {
      id: PERSON.diana,
      name: 'Диана',
      login: 'diana',
      gender: 'f',
      role: 'manager',
      models: ['lora', 'lily'],
      posts_on: ['fansly'],
      sessions: 1,
      last_seen_at: now,
      version: 1,
    },
    {
      id: PERSON.nikita,
      name: 'Никита',
      login: 'nikita',
      gender: 'm',
      role: 'manager',
      models: ['lora'],
      posts_on: ['onlyfans'],
      sessions: 1,
      last_seen_at: '2026-09-22T10:02:00Z',
      version: 1,
    },
    {
      id: PERSON.fyper,
      name: 'Fyper',
      login: 'fyper',
      gender: 'm',
      role: 'reader',
      models: ['lora'],
      posts_on: [],
      sessions: 1,
      last_seen_at: '2026-09-21T16:40:00Z',
      version: 1,
    },
  ]
}

export function buildAgents(): Agent[] {
  return [
    {
      id: AGENT.intake,
      name: 'Приёмка',
      role: 'manager',
      models: ['lora'],
      tokens: [
        {
          id: 't-intake-1',
          prefix: 'co_7f3a',
          issued_at: '2026-09-01T09:00:00Z',
          expires_at: '2026-12-01T09:00:00Z',
          last_used_at: '2026-09-22T11:17:00Z',
          revoked_at: null,
        },
      ],
    },
    {
      id: AGENT.orders,
      name: 'Заказы',
      role: 'manager',
      models: ['lora'],
      tokens: [
        {
          id: 't-orders-1',
          prefix: 'co_c21e',
          issued_at: '2026-09-10T09:00:00Z',
          expires_at: null,
          last_used_at: '2026-09-22T09:14:00Z',
          revoked_at: null,
        },
      ],
    },
    {
      id: AGENT.import,
      name: 'Импорт',
      role: 'manager',
      models: ['lora', 'lily'],
      tokens: [
        {
          id: 't-import-1',
          prefix: 'co_90bd',
          issued_at: '2026-08-28T09:00:00Z',
          expires_at: '2026-10-28T09:00:00Z',
          last_used_at: '2026-09-22T10:48:00Z',
          revoked_at: null,
        },
      ],
    },
  ]
}

export function buildContractors(): Contractor[] {
  return [
    { id: 'c-garanteam', name: 'GaranTTeam Social', channels: ['instagram'], format: 'compact' },
    { id: 'c-coraline', name: 'Coraline Red', channels: ['gif'], format: 'compact' },
    { id: 'c-truehelper', name: 'True Helper', channels: ['sfs'], format: 'compact' },
  ]
}

/** Names as agents appear in sentences: «Агент приёмки принял LIFE-191». */
const AGENT_ACTOR_NAME: Record<string, string> = {
  [AGENT.intake]: 'Агент приёмки',
  [AGENT.orders]: 'Агент заказов',
  [AGENT.import]: 'Агент импорта',
}

export const SYSTEM_ACTOR: ActorRef = { type: 'system', id: null, name: 'Система', gender: null }

export function personActor(person: Person): ActorRef {
  return { type: 'person', id: person.id, name: person.name, gender: person.gender }
}

/** Resolves a person or agent id to an actor; unknown ids become the system. */
export function actorOf(id: string, people: readonly Person[]): ActorRef {
  const person = people.find((candidate) => candidate.id === id)
  if (person) return personActor(person)
  const agentName = AGENT_ACTOR_NAME[id]
  if (agentName) return { type: 'agent', id, name: agentName, gender: 'm' }
  return SYSTEM_ACTOR
}

export function nameOf(id: string, people: readonly Person[]): PersonName {
  const actor = actorOf(id, people)
  return { name: actor.name, gender: actor.gender }
}
