import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { agentHandlers } from './agents'
import { authHandlers } from './auth'
import { integrationHandlers } from './integrations'
import { journalHandlers } from './journal'
import { modelHandlers } from './models'
import { normHandlers } from './norm'
import { peopleHandlers } from './people'
import { systemHandlers } from './system'
import { thresholdHandlers } from './thresholds'

/** Several registries into one; a route answered twice is a mistake caught at start. */
export function mergeHandlers(...registries: HandlerRegistry[]): HandlerRegistry {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const registry of registries) {
    for (const [area, routes] of Object.entries(registry)) {
      const target = merged[area] ?? {}
      merged[area] = target
      for (const [name, handler] of Object.entries(routes ?? {})) {
        if (target[name]) throw new Error(`handler ${area}.${name} registered twice`)
        target[name] = handler
      }
    }
  }
  return merged as HandlerRegistry
}

/** Every route the server answers on top of the table; the rest are 501 until their stage. */
export function createHandlers(services: Services): HandlerRegistry {
  return mergeHandlers(
    authHandlers(services),
    peopleHandlers(services),
    agentHandlers(services),
    modelHandlers(services),
    normHandlers(services),
    journalHandlers(services),
    integrationHandlers(services),
    thresholdHandlers(services),
    systemHandlers(services),
  )
}
