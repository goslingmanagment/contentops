import { createHash } from 'node:crypto'
import { type HubAgentKeys, HubError } from '@contentops/hub'

/**
 * An agent's hub key (SPEC §11.1, ecosystem package M2): «who is this key» asked at Hub with
 * ContentOps' own key, by the key's sha256 only, and remembered:
 *
 * - an answer holds 60 s (Hub's `cacheSeconds`, at most): a key revoked at Hub stops here within
 *   a minute;
 * - when Hub cannot be reached (network, timeout, 5xx) the last ACTIVE answer holds up to an hour
 *   after it was fetched (Hub's `staleSeconds`, at most) and never past the key's expiry; an
 *   inactive answer is never extended; while holding, Hub is asked again at most every 15 s;
 * - a 4xx or a malformed answer from Hub is an answer: refused, and nothing is held after it.
 *
 * The key and its digest are never logged or stored; the digest lives only as the cache key.
 */

export const HUB_KEY_FRESH_MS = 60_000
export const HUB_KEY_HOLD_MS = 60 * 60_000
const RETRY_MS = 15_000
const MAX_ENTRIES = 4096
/** Questions to Hub per minute, whoever asks: made-up keys must not spend its limit. */
const ASKS_PER_MINUTE = 120

export type HubKeyVerdict =
  | { kind: 'active'; code: string; held: boolean }
  /** Unknown, revoked, expired, not an agent's: Hub does not say which. */
  | { kind: 'inactive' }
  /** Hub cannot be reached and no active answer is held. */
  | { kind: 'unreachable' }
  /** Hub refused ContentOps' key or the question. */
  | { kind: 'refused' }

export interface HubAgentKeyService {
  who(token: string): Promise<HubKeyVerdict>
}

interface Entry {
  active: boolean
  code: string
  expiresAt: number
  fetchedAt: number
  freshMs: number
  holdMs: number
  /** The last failed refresh while holding. */
  triedAt: number | null
}

function clampMs(seconds: number, limitMs: number): number {
  const ms = seconds * 1000
  return ms > 0 && ms <= limitMs ? ms : limitMs
}

function isOutage(error: unknown): boolean {
  return (
    error instanceof HubError &&
    error.kind === 'transient' &&
    (error.status === null || error.status >= 500)
  )
}

export function createHubAgentKeyService(
  hub: HubAgentKeys,
  options: { now?: () => number; onError?: (error: unknown) => void } = {},
): HubAgentKeyService {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Promise<HubKeyVerdict>>()
  let asks: number[] = []

  const verdictOf = (entry: Entry, at: number, held: boolean): HubKeyVerdict =>
    entry.active && at < entry.expiresAt
      ? { kind: 'active', code: entry.code, held }
      : { kind: 'inactive' }
  const holdable = (entry: Entry | undefined, at: number): entry is Entry =>
    entry?.active === true && at - entry.fetchedAt < entry.holdMs && at < entry.expiresAt

  function store(digest: string, entry: Entry) {
    if (!entries.has(digest) && entries.size >= MAX_ENTRIES) {
      const at = now()
      for (const [key, old] of entries) {
        if (at - old.fetchedAt >= old.freshMs && !holdable(old, at)) entries.delete(key)
      }
      for (const key of entries.keys()) {
        if (entries.size < MAX_ENTRIES) break
        entries.delete(key)
      }
    }
    entries.set(digest, entry)
  }

  async function refresh(digest: string): Promise<HubKeyVerdict> {
    const fetchedAt = now()
    try {
      const answer = await hub.introspect(digest)
      const entry: Entry = {
        active: answer.active,
        code: answer.active ? answer.agent.code : '',
        expiresAt: answer.active ? answer.expiresAt.getTime() : 0,
        fetchedAt,
        freshMs: clampMs(answer.cacheSeconds, HUB_KEY_FRESH_MS),
        holdMs: clampMs(answer.staleSeconds, HUB_KEY_HOLD_MS),
        triedAt: null,
      }
      store(digest, entry)
      return verdictOf(entry, now(), false)
    } catch (error) {
      options.onError?.(error)
      const at = now()
      const known = entries.get(digest)
      if (!isOutage(error)) {
        entries.delete(digest)
        return { kind: 'refused' }
      }
      if (holdable(known, at)) {
        known.triedAt = at
        return verdictOf(known, at, true)
      }
      entries.delete(digest)
      return { kind: 'unreachable' }
    }
  }

  return {
    who(token) {
      const digest = createHash('sha256').update(token, 'utf8').digest('hex')
      const at = now()
      const known = entries.get(digest)
      if (known && at - known.fetchedAt < known.freshMs) {
        return Promise.resolve(verdictOf(known, at, false))
      }
      if (holdable(known, at) && known.triedAt !== null && at - known.triedAt < RETRY_MS) {
        return Promise.resolve(verdictOf(known, at, true))
      }
      const asking = pending.get(digest)
      if (asking) return asking
      asks = asks.filter((time) => at - time < 60_000)
      if (asks.length >= ASKS_PER_MINUTE) {
        return Promise.resolve(
          holdable(known, at) ? verdictOf(known, at, true) : { kind: 'unreachable' },
        )
      }
      asks.push(at)
      const run = refresh(digest).finally(() => pending.delete(digest))
      pending.set(digest, run)
      return run
    },
  }
}
