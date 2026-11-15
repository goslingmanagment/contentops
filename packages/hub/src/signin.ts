import { HubError } from './errors.ts'
import { badShape, callJson, type HttpContext, int, isRecord, str } from './http.ts'

/**
 * «Войти через хаб» (SPEC §11.1): the server-to-server half of Hub's sign-in for another
 * service. The browser brings a one-time code from Hub; ContentOps exchanges it with its own
 * key (capability `signin:<client>`) for «who is this» and an opaque grant, then asks again
 * with the grant whether that person is still signed in at Hub. Hub's session token never
 * comes here.
 */

export type HubRole = 'owner' | 'team_lead' | 'chatter' | 'content_manager' | (string & {})

/**
 * The person behind a sign-in as Hub's registry has them (products plan §4.1): enough for ContentOps
 * to make, change and close its own person. Models are Hub's lower-case model slugs.
 */
export interface HubPerson {
  code: string
  displayName: string
  /** `owner | team_lead | chatter | content_manager | contractor` in Hub's registry. */
  role: string
  /** `invited | set_up | working | left`. */
  state: string
  /** The models of the person's working pages. */
  models: string[]
  /** The models where the person leads customs («ведёт кастомы»). */
  customsModels: string[]
  /** What Hub's `auth/me` gives the person: the frame's switcher. */
  products: string[]
}

/** One open matter of the person in Hub, for «Ждут вас»: it opens where it is decided. */
export interface HubWaitingMatter {
  id: number
  kind: string
  title: string
  /** A path of Hub or Workboard, or an address; null — Hub's list. */
  link: string | null
  pageLabels: string[]
  openedAt: Date
}

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
  /**
   * Who this is in Hub's registry; null — the login is nobody's there; undefined — this Hub does not
   * say (before products plan §4.1): ContentOps then links the owner alone, as before.
   */
  person?: HubPerson | null
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
  /** What waits in Hub for the person of the grant; null — the sign-in is over. Reads only. */
  waiting(grant: string, signal?: AbortSignal): Promise<HubWaitingMatter[] | null>
  /**
   * ContentOps' own entrance (package C4): the login and the password typed on ContentOps' page, checked by Hub's own
   * sign-in. Never retried: a lost answer may have counted a try. The password is not logged.
   */
  signIn(input: { username: string; password: string } & HubClientOrigin): Promise<HubSignedIn>
  /** An invitation's or a new password's link (`/join#…`) set on ContentOps' page. */
  setPasswordByLink(
    input: { token: string; password: string } & HubClientOrigin,
  ): Promise<HubSignedIn>
  /** «Сменить пароль» from ContentOps' profile: every sign-in ends; a new grant comes back. */
  changePassword(
    input: { grant: string; currentPassword: string; newPassword: string } & HubClientOrigin,
  ): Promise<HubSignedIn>
  /** «Выйти»: Hub ends the session ContentOps' page opened (not one the person opened in Hub). */
  signOut(grant: string): Promise<boolean>
}

/** The person's address and browser as ContentOps saw them: for Hub's journal of sign-ins. */
export interface HubClientOrigin {
  ip?: string | undefined
  userAgent?: string | undefined
}

/**
 * Why Hub said no, in one word: `wrong` — an unknown login or a wrong password; `locked` — too many tries; `owner` —
 * the owner enters through Hub; `no_access` — no ContentOps for this person; the link's own words; `weak` — Hub does
 * not take the password (`message` says why); `not_here` — a link of a login that opens elsewhere.
 */
export type HubRefusal =
  | 'wrong'
  | 'locked'
  | 'owner'
  | 'no_access'
  | 'link_unknown'
  | 'link_used'
  | 'link_expired'
  | 'link_revoked'
  | 'not_here'
  | 'weak'

export type HubSignedIn =
  | { kind: 'signed_in'; redeemed: HubRedeemed }
  | { kind: 'refused'; reason: HubRefusal; message: string | null }

const REFUSALS: ReadonlySet<string> = new Set<HubRefusal>([
  'wrong',
  'locked',
  'owner',
  'no_access',
  'link_unknown',
  'link_used',
  'link_expired',
  'link_revoked',
  'not_here',
  'weak',
])

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

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((one) => typeof one === 'string') ? value : null
}

function hubPersonOf(endpoint: string, value: unknown): HubPerson | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRecord(value)) throw badShape(endpoint, 'person is not an object')
  const code = str(value.code)
  const displayName = str(value.displayName)
  const role = str(value.role)
  const state = str(value.state)
  const models = strings(value.models)
  const customsModels = strings(value.customsModels)
  const products = strings(value.products)
  if (
    code === null ||
    displayName === null ||
    role === null ||
    state === null ||
    models === null ||
    customsModels === null ||
    products === null
  ) {
    throw badShape(endpoint, 'person lacks a field')
  }
  return { code, displayName, role, state, models, customsModels, products }
}

function personOf(endpoint: string, value: Record<string, unknown>): HubSigninPerson {
  const expires = str(value.expiresAt)
  const expiresAt = expires === null ? null : new Date(expires)
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    throw badShape(endpoint, 'expiresAt is missing')
  }
  if (typeof value.owner !== 'boolean') throw badShape(endpoint, 'owner is missing')
  const person = hubPersonOf(endpoint, value.person)
  return {
    user: userOf(endpoint, value.user),
    owner: value.owner,
    expiresAt,
    ...(person === undefined ? {} : { person }),
  }
}

function origin(ip: string | undefined, userAgent: string | undefined) {
  return {
    ...(ip ? { ip: ip.slice(0, 64) } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 512) } : {}),
  }
}

/** A door's answer: signed in (what `redeem` gives) or refused in one word. */
async function signedIn(
  ctx: HttpContext,
  endpoint: string,
  path: string,
  json: Record<string, unknown>,
): Promise<HubSignedIn> {
  const answer = await callJson(ctx, endpoint, { method: 'POST', path, json })
  if (!isRecord(answer)) throw badShape(endpoint, 'not an object')
  if (answer.result === 'refused') {
    const reason = str(answer.reason)
    if (reason === null || !REFUSALS.has(reason)) throw badShape(endpoint, 'unknown refusal')
    return { kind: 'refused', reason: reason as HubRefusal, message: str(answer.message) }
  }
  if (answer.result !== 'signed_in') throw badShape(endpoint, 'result is missing')
  const grant = str(answer.grant)
  if (grant === null || grant === '') throw badShape(endpoint, 'grant is missing')
  return { kind: 'signed_in', redeemed: { ...personOf(endpoint, answer), grant } }
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

    async signIn({ username, password, ip, userAgent }) {
      return signedIn(ctx, 'signin.password', 'api/v1/auth/sso/password', {
        client,
        username,
        password,
        ...origin(ip, userAgent),
      })
    },

    async setPasswordByLink({ token, password, ip, userAgent }) {
      return signedIn(ctx, 'signin.link', 'api/v1/auth/sso/link', {
        client,
        token,
        password,
        ...origin(ip, userAgent),
      })
    },

    async changePassword({ grant, currentPassword, newPassword, ip, userAgent }) {
      return signedIn(ctx, 'signin.passwordChange', 'api/v1/auth/sso/password-change', {
        client,
        grant,
        currentPassword,
        newPassword,
        ...origin(ip, userAgent),
      })
    },

    async signOut(grant) {
      const endpoint = 'signin.logout'
      const answer = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/auth/sso/logout',
        json: { client, grant },
      })
      if (!isRecord(answer) || typeof answer.ended !== 'boolean')
        throw badShape(endpoint, 'ended is missing')
      return answer.ended
    },

    async waiting(grant, signal) {
      const endpoint = 'signin.waiting'
      const answer = await callJson(ctx, endpoint, {
        method: 'POST',
        path: 'api/v1/auth/sso/waiting',
        json: { client, grant },
        ...(signal ? { signal } : {}),
      })
      if (!isRecord(answer) || typeof answer.active !== 'boolean') {
        throw badShape(endpoint, 'active is missing')
      }
      if (!answer.active) return null
      if (!Array.isArray(answer.matters)) throw badShape(endpoint, 'matters is missing')
      return answer.matters.map((raw) => {
        if (!isRecord(raw)) throw badShape(endpoint, 'a matter is not an object')
        const id = int(raw.id)
        const kind = str(raw.kind)
        const title = str(raw.title)
        const opened = str(raw.openedAt)
        const pageLabels = strings(raw.pageLabels)
        const link = raw.link === null ? null : str(raw.link)
        if (
          id === null ||
          kind === null ||
          title === null ||
          opened === null ||
          pageLabels === null
        ) {
          throw badShape(endpoint, 'a matter lacks a field')
        }
        return { id, kind, title, link, pageLabels, openedAt: new Date(opened) }
      })
    },
  }
}

/** Hub said no to the code itself (used, expired, another client's): not a failure of Hub. */
export function isSpentCode(error: unknown): boolean {
  return error instanceof HubError && error.kind === 'refused' && error.status === 409
}
