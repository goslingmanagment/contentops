import {
  type HubCustomOrderAnswer,
  type HubCustomOrderList,
  type HubOrderPart,
  type HubShootingStep,
  parseHubOrderAnswer,
  parseHubOrderList,
} from './custom-orders.ts'
import { callJson, type HttpContext } from './http.ts'

/**
 * Hub's person's door (Hub `services/person-door.ts`, package C3): ContentOps acts in Hub AS THE
 * SIGNED-IN PERSON — its sign-in key (`signin:contentops`) and the person's live grant — so Hub's
 * rights and the test realm's wall are the person's own, never ContentOps' key's. A grant that is
 * over answers 401 (`grant_inactive`): ContentOps ends its own session. Only «Съёмка»'s two rows here;
 * another package's rows (C2) may share this client.
 */

export interface PersonDoorOptions {
  /** Hub's console: `https://hub.example`. */
  baseUrl: string
  /** ContentOps' sign-in key (`signin:contentops`). Never logged. */
  key: string
  /** The client's name at Hub: `contentops`. */
  client: string
  fetch?: typeof fetch
  /** Per-request limit (default 15 s): a person waits for it. */
  timeoutMs?: number
  now?: () => Date
}

export interface PersonShootingStep {
  code: string
  step: HubShootingStep
  deadlineOn?: string
  note?: string
  part?: HubOrderPart
}

export interface PersonDoor {
  /** The open custom orders of the person's shooting (their scope and realm, by Hub). */
  customOrders(grant: string, signal?: AbortSignal): Promise<HubCustomOrderList>
  /** A shooting step as the person; Hub refuses whoever does not lead it (409 `not_allowed`). */
  customOrderStep(
    grant: string,
    body: PersonShootingStep,
    signal?: AbortSignal,
  ): Promise<HubCustomOrderAnswer>
}

export function createPersonDoor(options: PersonDoorOptions): PersonDoor {
  const ctx: HttpContext = {
    baseUrl: options.baseUrl,
    key: options.key,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 15_000,
    now: options.now ?? (() => new Date()),
  }
  const client = options.client
  return {
    async customOrders(grant, signal) {
      const endpoint = 'person.custom-orders'
      return parseHubOrderList(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/custom-orders/list',
          json: { client, grant },
          signal,
        }),
        endpoint,
      )
    },
    async customOrderStep(grant, body, signal) {
      const endpoint = 'person.custom-orders.step'
      return parseHubOrderAnswer(
        await callJson(ctx, endpoint, {
          method: 'POST',
          path: 'api/v1/person/custom-orders/step',
          json: { client, grant, ...body },
          signal,
        }),
        endpoint,
      )
    },
  }
}
