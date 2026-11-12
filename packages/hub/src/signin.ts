import { HubError } from './errors.ts'
import { badShape, callJson, type HttpContext, int, isRecord, str } from './http.ts'

/**
 * «Войти через хаб» (SPEC §11.1): the server-to-server half of Hub's sign-in for another
 * service. The browser brings a one-time code from Hub; ContentOps exchanges it with its own
 * key (capability `signin:<client>`) for «who is this» and an opaque grant, then asks again
 * with the grant whether that person is still signed in at Hub. Hub's session token never
 * comes here.
 */

export type HubRole = 'owner' | 'team_lead' | 'chatter' | (string & {})

export interface HubSigninUser {
  id: number
  username: string
  role: HubRole
}

export interface HubSigninPerson {
  user: HubSigninUser
  /** The agency's owner at Hub. */
  owner: boolean
  /** Hub's session behind the sign-in ends then at the latest. */
  expiresAt: Date
}

export interface HubRedeemed extends HubSigninPerson {
  /** Opaque: the question «still signed in?» is asked with it. */
  grant: string
}

export type HubCheck = ({ active: true } & HubSigninPerson) | { active: false }

export interface HubSignin {
  /**
   * The browser's address at Hub: it signs in there if needed and comes back with a code.
   * `silent`: Hub never shows its sign-in page; nobody signed in there comes back as
   * `error=none` (no code).
   */
  startUrl(input: { state: string; next: string; silent?: boolean }): string
  /** Whether Hub answers at all (its health, within 2 s): asked before a silent try. */
  answers(): Promise<boolean>
  /**
   * Spends the code: `refused` (409) when it is unknown, used, expired or another client's;
   * never retried — a lost answer has spent it anyway.
   */
  redeem(code: string, signal?: AbortSignal): Promise<HubRedeemed>
  /** Whether the person of the grant is still signed in at Hub. Reads only. */
  check(grant: string, signal?: AbortSignal): Promise<HubCheck>
}

export interface HubSigninOptions {
  /** Hub's console name: `https://hub.example`; the browser and this server both go there. */
  baseUrl: string
  /** The key with `signin:<client>`. Never logged. */
  key: string
  /** The client's name at Hub: `contentops`. */
  client: string
  fetch?: typeof fetch
  /** Per-request limit (default 10 s): a person waits for it. */
  timeoutMs?: number
  now?: () => Date
}

function userOf(endpoint: string, value: unknown): HubSigninUser {
  if (!isRecord(value)) throw badShape(endpoint, 'user is missing')
  const id = int(value.id)
  const username = str(value.username)
  const role = str(value.role)
  if (id === null || id < 1 || username === null || role === null) {
    throw badShape(endpoint, 'user has no id, username or role')
  }
  return { id, username, role }
}

function personOf(endpoint: string, value: Record<string, unknown>): HubSigninPerson {
  const expires = str(value.expiresAt)
  const expiresAt = expires === null ? null : new Date(expires)
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    throw badShape(endpoint, 'expiresAt is missing')
  }
  if (typeof value.owner !== 'boolean') throw badShape(endpoint, 'owner is missing')
  return { user: userOf(endpoint, value.user), owner: value.owner, expiresAt }
}

/** How long a silent try waits to learn whether Hub answers at all. */
const HEALTH_TIMEOUT_MS = 2_000

export function createHubSignin(options: HubSigninOptions): HubSignin {
  const ctx: HttpContext = {
    baseUrl: options.baseUrl,
    key: options.key,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? 10_000,
    now: options.now ?? (() => new Date()),
  }
  const { client } = options

  return {
    startUrl({ state, next, silent = false }) {
      const url = new URL(
        'api/v1/auth/sso',
        ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`,
      )
      url.search = new URLSearchParams({
        to: client,
        state,
        next,
        ...(silent ? { silent: '1' } : {}),
      }).toString()
      return url.href
    },

    async answers() {
      // No key: the health is public, and the key is for redeem and check only.
      const url = new URL(
        'api/v1/health',
        ctx.baseUrl.endsWith('/') ? ctx.baseUrl : `${ctx.baseUrl}/`,
      )
      try {
        const response = await ctx.fetch(url, {
          headers: { accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        await response.body?.cancel().catch(() => undefined)
        return response.ok
      } catch {
        return false
      }
    },

    async redeem(code, signal) {
      const endpoint = 'signin.redeem'
      const answer = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/auth/sso/redeem',
        json: { client, code },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(answer)) throw badShape(endpoint, 'not an object')
      const grant = str(answer.grant)
      if (grant === null || grant === '') throw badShape(endpoint, 'grant is missing')
      return { ...personOf(endpoint, answer), grant }
    },

    async check(grant, signal) {
      const endpoint = 'signin.check'
      const answer = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/auth/sso/check',
        json: { client, grant },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(answer) || typeof answer.active !== 'boolean') {
        throw badShape(endpoint, 'active is missing')
      }
      if (!answer.active) return { active: false }
      return { active: true, ...personOf(endpoint, answer) }
    },
  }
}

/** Hub said no to the code itself (used, expired, another client's): not a failure of Hub. */
export function isSpentCode(error: unknown): boolean {
  return error instanceof HubError && error.kind === 'refused' && error.status === 409
}
