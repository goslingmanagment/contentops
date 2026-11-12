import { timingSafeEqual } from 'node:crypto'
import { type Db, logAction, SYSTEM_ACTOR, setJournalContext, withActorTx } from '@contentops/db'
import { type HubRedeemed, type HubSignin, isHubError, isSpentCode } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { parseCookies } from '../context'
import {
  deviceOf,
  HUB_SESSION_PREFIX,
  newSecret,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  sessionDigest,
  sha256,
} from './secrets'

/**
 * «Войти через хаб» (SPEC §11.1): a person signed in to Agency Hub opens ContentOps on its
 * public name without a second password. The browser goes to the hub with a state of ours
 * and comes back to `/auth/hub/callback` with a one-time code; this server exchanges the code
 * with its own hub key for «who is this» and opens its OWN session for the principal linked to
 * that hub person. The hub's session token never reaches this machine. Such a session asks the
 * hub again at most once a minute whether the person is still signed in there.
 *
 * Silent sign-in: a page that got 401 on the public name first goes to
 * `/auth/hub/start?silent=1` (`apps/web/src/screens/login/silent-hub.ts`), once — the hub never
 * shows its sign-in page then: signed in there, the person is back on the page signed in; nobody
 * there (`error=none`), the sign-in screen. The try is marked before the browser leaves
 * (`co_hub_try`, 10 minutes) and the hub's health is asked first, so a hub that does not answer
 * means the sign-in screen at once. «Выйти» leaves `co_hub_out` (until the browser session ends
 * or «Войти через хаб» is pressed). Both marks are readable by the page, they carry no secret.
 */

/** The hub is asked about a session at most this often. */
export const HUB_CHECK_EVERY_MS = 60_000
/**
 * While the hub does not answer (a deploy, the network), a session lives on the hub's last
 * «still signed in» for this long, then ends until the hub answers again.
 */
export const HUB_SILENCE_MS = 30 * 60_000
/** The state of a sign-in that went to the hub: enough to sign in there first. */
const STATE_SECONDS = 600
/** A silent try was made: no other for this long. */
const TRY_SECONDS = 600
/** Hub's codes: 32 random bytes, base64url. */
const CODE = /^[A-Za-z0-9_-]{43}$/
const SIGN_IN_ACTION = 'auth.hubSignIn'
const SYSTEM = SYSTEM_ACTOR('вход через хаб')

export interface HubSigninSetup {
  hub: HubSignin
  /** ContentOps' own address where the sign-in is offered: its callback is known at the hub. */
  origin: string
  /** The ContentOps owner whom the hub's owner signs in as (`HUB_SIGNIN_OWNER`). */
  ownerLogin: string | null
  /** Clock of the re-check; tests move it. */
  now?: () => number
}

/** A session opened through the hub, as `authenticate` found it. */
export interface HubSessionRow {
  sessionId: string
  principalId: string
  login: string
  /** `principals.hub_user_id` now: the link may have been taken away since. */
  hubUserId: string | null
  grant: string
  /** The hub's last «still signed in», ms. */
  checkedAtMs: number | null
}

export interface HubSessions {
  /** Whether the person of a hub session is still signed in at the hub (cached ≤ 60 s). */
  stillSignedIn(
    row: HubSessionRow,
    request: { id: string; log: FastifyBaseLogger },
  ): Promise<boolean>
}

export interface HubSigninService extends HubSessions {
  setup: HubSigninSetup
  /** The request came to the name where «Войти через хаб» is offered. */
  offeredAt(host: string): boolean
  /** True the first time a state or a code is presented, never again for its lifetime. */
  takeOnce(value: string): boolean
}

/** Why the sign-in screen is shown again (`/login?hub=…`). */
export type HubSigninRefusal = 'failed' | 'unreachable' | 'no_access'

interface Remembered {
  /** When the hub was last asked. */
  at: number
  ok: boolean
  /** The hub's last «still signed in». */
  activeAt: number
}

const MAX_REMEMBERED = 10_000

/** The origin `ownPath` parses against: never a real host. */
const OWN_PATH_BASE = 'http://contentops.invalid'

/** A path of ours for after the sign-in; anything else is the start page. */
export function ownPath(raw: unknown): string {
  // What is redirected to is always a path of this origin AFTER a URL parser's own normalisation (`/.//host` folds
  // into `//host`, a protocol-relative address): the value is parsed against a stand-in origin and must stay on it,
  // and its path — as written and decoded — has no backslash, control character or whitespace, no empty segment
  // (`//`, `/%2F/`) and no dot segment (`/./`, `/../`). The same table as Hub, TaskIndex and the monitor.
  if (typeof raw !== 'string' || raw.length > 2048) return '/'
  if (!raw.startsWith('/') || /[\\\s\p{Cc}]/u.test(raw)) return '/'
  const path = raw.split(/[?#]/, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return '/'
  }
  for (const form of [path, decoded]) {
    if (/[\\\s\p{Cc}]/u.test(form) || form.includes('//') || /(^|\/)\.{1,2}(\/|$)/.test(form))
      return '/'
    if (form.startsWith('/auth/') || form === '/login') return '/'
  }
  let url: URL
  try {
    url = new URL(raw, OWN_PATH_BASE)
  } catch {
    return '/'
  }
  const next = `${url.pathname}${url.search}${url.hash}`
  return url.origin !== OWN_PATH_BASE || next.startsWith('//') ? '/' : next
}

export function loginAddress(next: string, refusal?: HubSigninRefusal): string {
  const search = new URLSearchParams()
  if (next !== '/') search.set('from', next)
  if (refusal) search.set('hub', refusal)
  const query = search.toString()
  return query ? `/login?${query}` : '/login'
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** `__Host-` over HTTPS: a sibling name cannot set it, so nobody can bring their own state. */
function stateCookieName(secure: boolean): string {
  return secure ? '__Host-co_hub_state' : 'co_hub_state'
}

function stateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${stateCookieName(secure)}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** `__Host-` over HTTPS like the state; not HttpOnly: the page reads them before a silent try. */
function markName(mark: 'try' | 'out', secure: boolean): string {
  return `${secure ? '__Host-' : ''}co_hub_${mark}`
}

/** `try`: ten minutes; `out` («Выйти»): until the browser session ends; `set = false`: taken away. */
export function hubMarkCookie(mark: 'try' | 'out', secure: boolean, set = true): string {
  return [
    `${markName(mark, secure)}=${set ? '1' : ''}`,
    'Path=/',
    ...(!set ? ['Max-Age=0'] : mark === 'try' ? [`Max-Age=${TRY_SECONDS}`] : []),
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

/** Spent states and codes, so this server never takes one twice (the hub refuses it too). */
class Spent {
  private readonly until = new Map<string, number>()
  constructor(private readonly now: () => number) {}

  /** True the first time only. */
  take(value: string): boolean {
    const now = this.now()
    for (const [key, until] of this.until) {
      if (until > now && this.until.size <= MAX_REMEMBERED) break
      this.until.delete(key)
    }
    const key = sha256(value).toString('hex')
    if ((this.until.get(key) ?? 0) > now) return false
    this.until.set(key, now + STATE_SECONDS * 1000)
    return true
  }
}

interface SignInRow extends Record<string, unknown> {
  id: string
  login: string
  display_name: string
  disabled_at: string | null
  hub_login: string | null
}

export function createHubSigninService(db: Db, setup: HubSigninSetup): HubSigninService {
  const now = setup.now ?? Date.now
  const host = new URL(setup.origin).host.toLowerCase()
  const remembered = new Map<string, Remembered>()
  const pending = new Map<string, Promise<boolean>>()

  function remember(sessionId: string, value: Remembered) {
    remembered.delete(sessionId)
    remembered.set(sessionId, value)
    for (const oldest of remembered.keys()) {
      if (remembered.size <= MAX_REMEMBERED) break
      remembered.delete(oldest)
    }
  }

  async function end(row: HubSessionRow, requestId: string, reason: string) {
    await withActorTx(
      db,
      { actor: SYSTEM, action: 'auth.hubSessionEnded', requestId },
      async (tx) => {
        const revoked = await tx.execute(sql`
          UPDATE sessions SET revoked_at = now()
           WHERE id = ${row.sessionId}::uuid AND revoked_at IS NULL`)
        if ((revoked.rowCount ?? 0) === 0) return
        await logAction(tx, {
          modelId: null,
          subjectKind: 'principals',
          subjectId: row.principalId,
          subjectLabel: row.login,
          after: { Причина: reason },
        })
      },
    )
  }

  async function ask(
    row: HubSessionRow,
    known: Remembered | undefined,
    request: { id: string; log: FastifyBaseLogger },
  ): Promise<boolean> {
    const at = now()
    const activeAt = Math.max(known?.activeAt ?? 0, row.checkedAtMs ?? 0)
    let answer: Awaited<ReturnType<HubSignin['check']>>
    try {
      answer = await setup.hub.check(row.grant)
    } catch (error) {
      // Only «the hub did not answer» (the network, a 5xx, a timeout, its limit) keeps the last «signed in» for a
      // while. A refusal (401, 403, 404, a bad request) or an answer that breaks the contract cannot confirm the
      // sign-in: it ends now, as when the hub says the person is gone.
      if (!isHubError(error, 'transient') && !isHubError(error, 'rate_limited')) {
        remember(row.sessionId, { at, ok: false, activeAt })
        request.log.warn(
          { err: error, session: row.sessionId },
          'the hub refused to say whether a person is still signed in: the session ends',
        )
        await end(row, request.id, 'хаб не подтвердил вход')
        return false
      }
      const ok = at - activeAt < HUB_SILENCE_MS
      remember(row.sessionId, { at, ok, activeAt })
      request.log.warn(
        { err: error, session: row.sessionId, holds: ok },
        'the hub did not answer whether a person is still signed in',
      )
      return ok
    }
    if (answer.active && row.hubUserId !== null && String(answer.user.id) === row.hubUserId) {
      remember(row.sessionId, { at, ok: true, activeAt: at })
      await db.execute(sql`UPDATE sessions SET hub_checked_at = now()
        WHERE id = ${row.sessionId}::uuid AND revoked_at IS NULL`)
      return true
    }
    remember(row.sessionId, { at, ok: false, activeAt })
    await end(
      row,
      request.id,
      answer.active ? 'связь с хабом снята или изменена' : 'вышел из хаба или потерял доступ',
    )
    return false
  }

  const spent = new Spent(now)

  return {
    setup,
    takeOnce: (value) => spent.take(value),
    offeredAt: (requestHost) => requestHost.toLowerCase() === host,
    stillSignedIn(row, request) {
      const known = remembered.get(row.sessionId)
      if (known && now() - known.at < HUB_CHECK_EVERY_MS) return Promise.resolve(known.ok)
      const asking = pending.get(row.sessionId)
      if (asking) return asking
      const run = ask(row, known, request).finally(() => pending.delete(row.sessionId))
      pending.set(row.sessionId, run)
      return run
    },
  }
}

/**
 * The principal of the hub person: the one linked to it, or — the first time the hub's owner
 * comes — the configured owner, linked now. Then a session of ours with the hub's grant.
 * `null` — no principal for that person: no session.
 */
async function openSession(
  db: Db,
  setup: HubSigninSetup,
  person: HubRedeemed,
  request: { id: string; userAgent: string | null; previous: string | undefined },
): Promise<string | null> {
  const { user } = person
  return withActorTx(
    db,
    { actor: SYSTEM, action: SIGN_IN_ACTION, requestId: request.id },
    async (tx) => {
      const { rows: found } = await tx.execute<SignInRow>(sql`
        SELECT id, login, display_name, disabled_at, hub_login FROM principals
         WHERE hub_user_id = ${user.id} AND kind = 'human' FOR UPDATE`)
      let row = found[0]
      if (!row && person.owner && setup.ownerLogin !== null) {
        const { rows: linked } = await tx.execute<SignInRow>(sql`
          UPDATE principals SET hub_user_id = ${user.id}, hub_login = ${user.username},
                 row_version = row_version + 1
           WHERE login = ${setup.ownerLogin} AND kind = 'human' AND role = 'owner'
             AND disabled_at IS NULL AND hub_user_id IS NULL
          RETURNING id, login, display_name, disabled_at, hub_login`)
        row = linked[0]
        if (row) {
          await logAction(tx, {
            action: 'auth.hubLink',
            modelId: null,
            subjectKind: 'principals',
            subjectId: row.id,
            subjectLabel: row.login,
            before: { Хаб: 'нет связи' },
            after: { Хаб: user.username },
          })
        }
      }
      if (!row || row.disabled_at !== null) {
        await logAction(tx, {
          modelId: null,
          subjectKind: 'principals',
          subjectId: row?.id ?? null,
          subjectLabel: `${user.username} из хаба`,
          result: 'denied',
        })
        return null
      }
      if (row.hub_login !== user.username) {
        await tx.execute(sql`UPDATE principals SET hub_login = ${user.username}
          WHERE id = ${row.id}::uuid`)
      }
      await setJournalContext(tx, {
        actor: { type: 'human', id: row.id, label: row.display_name },
        action: SIGN_IN_ACTION,
        requestId: request.id,
      })
      const token = newSecret(HUB_SESSION_PREFIX)
      const { rows: created } = await tx.execute<{ id: string }>(sql`
        INSERT INTO sessions (principal_id, token_hash, user_agent, expires_at, hub_grant,
                              hub_checked_at)
        VALUES (${row.id}::uuid, ${sessionDigest(token)}, ${request.userAgent},
                least(now() + ${`${SESSION_DAYS} days`}::interval,
                      ${person.expiresAt.toISOString()}::timestamptz),
                ${person.grant}, now())
        RETURNING id`)
      const session = created[0]
      if (!session) throw new Error('session insert returned nothing')
      // Rotation, as with the password: the session this browser had before is replaced.
      if (request.previous) {
        await tx.execute(sql`
          UPDATE sessions SET revoked_at = now(), replaced_by_id = ${session.id}::uuid
           WHERE token_hash = ${sessionDigest(request.previous)}
             AND principal_id = ${row.id}::uuid AND revoked_at IS NULL`)
      }
      await logAction(tx, {
        modelId: null,
        subjectKind: 'principals',
        subjectId: row.id,
        subjectLabel: row.login,
        after: { Устройство: deviceOf(request.userAgent), Хаб: user.username },
      })
      return token
    },
  )
}

/** The answers of the two steps are never stored, framed or sent on as a Referer. */
function handoffHeaders(reply: FastifyReply) {
  reply.header('cache-control', 'no-store')
  reply.header('referrer-policy', 'no-referrer')
  reply.header('x-frame-options', 'DENY')
  reply.header('content-security-policy', "frame-ancestors 'none'")
}

function single(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface HubRoutesOptions {
  db: Db
  service: HubSigninService | null
  /** `PUBLIC_URL` is https. */
  secureCookies: boolean
}

/**
 * `/auth/hub/start` and `/auth/hub/callback`, outside `/api/` (the hub's contract): browser
 * navigations answered with a redirect. Where the hub sign-in is not offered both lead to the
 * sign-in screen. The callback's request line carries the code: it is not logged.
 */
export function registerHubSignin(app: FastifyInstance, options: HubRoutesOptions): void {
  const { db, service } = options
  const secureOf = (request: FastifyRequest) =>
    options.secureCookies || request.protocol === 'https'
  // No request line with a code in the log: the callback logs from `warn` up (or quieter still).
  const quieter = (['fatal', 'error', 'silent'] as const).find((level) => level === app.log.level)
  const callbackLevel = quieter ?? 'warn'

  app.get('/auth/hub/start', { schema: { hide: true } }, async (request, reply) => {
    handoffHeaders(reply)
    const query = request.query as Record<string, unknown>
    const next = ownPath(query.next)
    if (!service?.offeredAt(request.host)) return reply.redirect(loginAddress(next), 302)
    const secure = secureOf(request)
    const cookies = parseCookies(request.headers.cookie)
    const silent = query.silent === '1'
    if (silent) {
      // One silent try: not after «Выйти» here, not twice in ten minutes, not to a hub that
      // does not answer — then the sign-in screen at once.
      if (cookies[markName('try', secure)] || cookies[markName('out', secure)]) {
        return reply.redirect(loginAddress(next), 302)
      }
      if (!(await service.setup.hub.answers())) {
        request.log.warn('the hub does not answer: no silent sign-in')
        reply.header('set-cookie', hubMarkCookie('try', secure))
        return reply.redirect(loginAddress(next), 302)
      }
    }
    const state = newSecret()
    reply.header('set-cookie', [
      stateCookie(state, STATE_SECONDS, secure),
      // Marked before the browser leaves; pressed by the person, the «signed out here» mark is over.
      hubMarkCookie('try', secure),
      ...(!silent && cookies[markName('out', secure)] ? [hubMarkCookie('out', secure, false)] : []),
    ])
    return reply.redirect(service.setup.hub.startUrl({ state, next, silent }), 302)
  })

  app.get(
    '/auth/hub/callback',
    { schema: { hide: true }, logLevel: callbackLevel },
    async (request, reply) => {
      handoffHeaders(reply)
      const query = request.query as Record<string, unknown>
      const next = ownPath(query.next)
      if (!service?.offeredAt(request.host)) return reply.redirect(loginAddress(next), 302)
      const secure = secureOf(request)
      const cookies = parseCookies(request.headers.cookie)
      const ours = cookies[stateCookieName(secure)]
      const state = single(query.state)
      const code = single(query.code)
      const cookiesOut = [stateCookie('', 0, secure)]
      // A silent try found nobody at the hub: the sign-in screen. Nothing is redeemed.
      if (query.error !== undefined) {
        reply.header('set-cookie', [...cookiesOut, hubMarkCookie('try', secure)])
        return reply.redirect(loginAddress(next), 302)
      }
      const refuse = (refusal: HubSigninRefusal, reason: string) => {
        request.log.warn({ reason }, 'hub sign-in refused')
        reply.header('set-cookie', cookiesOut)
        return reply.redirect(loginAddress(next, refusal), 302)
      }
      // The state is spent at its first callback whatever happens next.
      if (!ours || !state || !sameSecret(ours, state) || !service.takeOnce(`state:${state}`)) {
        return refuse('failed', 'state')
      }
      if (!CODE.test(code) || !service.takeOnce(`code:${code}`)) return refuse('failed', 'code')
      let person: HubRedeemed
      try {
        person = await service.setup.hub.redeem(code)
      } catch (error) {
        if (isSpentCode(error)) return refuse('failed', 'code spent at the hub')
        request.log.error({ err: error }, 'the hub did not redeem a sign-in code')
        return refuse(
          isHubError(error, 'transient') || isHubError(error, 'rate_limited')
            ? 'unreachable'
            : 'failed',
          'redeem',
        )
      }
      const token = await openSession(db, service.setup, person, {
        id: request.id,
        userAgent:
          typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        previous: cookies[SESSION_COOKIE],
      })
      if (token === null) return refuse('no_access', 'no principal for this hub person')
      cookiesOut.push(sessionCookie(token, { secure }))
      reply.header('set-cookie', cookiesOut)
      return reply.redirect(next, 302)
    },
  )
}
