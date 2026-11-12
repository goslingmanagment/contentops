import { badShape, callJson, type HttpContext, isRecord, str } from './http.ts'

/**
 * «Кто этот ключ» (SPEC §11.1; the hub's `docs/agent-doors.md`): an agent may call ContentOps
 * with its Agency Hub key. ContentOps sends Hub ONLY the key's sha256 (lowercase hex), as the
 * bearer of its OWN key holding `introspect:agent_keys` — never the agent's key — and learns the
 * agent's code, whether the key works and until when. No key material, capability or page comes
 * back.
 */

/** Every agent key of Hub starts with it; a bearer without it is a ContentOps token. */
export const HUB_AGENT_KEY_PREFIX = 'agency_hub_agent_'

/** Hub's person code (`PERSON_CODE_PATTERN` of its contracts). */
export const HUB_AGENT_CODE = /^[a-z0-9][a-z0-9-]{0,62}$/

export type HubKeyAnswer =
  | {
      active: true
      agent: { code: string; displayName: string }
      expiresAt: Date
      /** How long the answer may be used as it is. */
      cacheSeconds: number
      /** How long an active answer may be kept while Hub cannot be reached, from its fetch. */
      staleSeconds: number
    }
  | { active: false; cacheSeconds: number; staleSeconds: number }

export interface HubAgentKeys {
  /** Who the key of this digest is. Reads only: the key's own use at Hub does not move. */
  introspect(keyDigest: string, signal?: AbortSignal): Promise<HubKeyAnswer>
}

export interface HubAgentKeysOptions {
  /** Hub's address: `https://hub.example`. */
  baseUrl: string
  /** ContentOps' own key with `introspect:agent_keys`. Never logged. */
  key: string
  fetch?: typeof fetch
  /** Per-request limit (default 5 s): an agent waits for it. */
  timeoutMs?: number
  now?: () => Date
}

const DIGEST = /^[0-9a-f]{64}$/

function seconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function createHubAgentKeys(options: HubAgentKeysOptions): HubAgentKeys {
  const ctx: HttpContext = {
    baseUrl: options.baseUrl,
    key: options.key,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 5_000,
    now: options.now ?? (() => new Date()),
  }
  return {
    async introspect(keyDigest, signal) {
      const endpoint = 'agentKeys.introspect'
      if (!DIGEST.test(keyDigest)) throw badShape(endpoint, 'the digest is not sha256 hex')
      const answer = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/agent/keys/introspect',
        json: { keyDigest },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(answer) || typeof answer.active !== 'boolean') {
        throw badShape(endpoint, 'active is missing')
      }
      const cache = {
        cacheSeconds: seconds(answer.cacheSeconds),
        staleSeconds: seconds(answer.staleSeconds),
      }
      if (!answer.active) return { active: false, ...cache }
      const agent = isRecord(answer.agent) ? answer.agent : null
      const code = agent ? str(agent.code) : null
      const expires = str(answer.expiresAt)
      const expiresAt = expires === null ? null : new Date(expires)
      if (
        code === null ||
        !HUB_AGENT_CODE.test(code) ||
        expiresAt === null ||
        Number.isNaN(expiresAt.getTime())
      ) {
        throw badShape(endpoint, 'an active answer without the agent or its expiry')
      }
      return {
        active: true,
        agent: { code, displayName: str(agent?.displayName) ?? code },
        expiresAt,
        ...cache,
      }
    },
  }
}
