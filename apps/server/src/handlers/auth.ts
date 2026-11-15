import type { Session } from '@contentops/contracts/domain/admin'
import { logAction, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { hash, verify } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import { HUB_SILENT_WORDS, REFUSAL_WORDS, refusalProblem, throughHub } from '../auth/hub-form'
import { hubMarkCookie } from '../auth/hub-signin'
import {
  clearedSessionCookie,
  deviceOf,
  newSecret,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  sessionDigest,
} from '../auth/secrets'
import { ADDRESS_RULE, LOGIN_RULE, Throttle } from '../auth/throttle'
import { instant, requireActor } from '../commands'
import type { RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { personById } from './people-view'
import { productLinks } from './products'

/** Sign-in, sign-out, the profile and own sessions (DESIGN §4.19 «Профиль и сессии», §4.21). */

const SKIN_LABEL = { blue: 'синий', focus: 'Фокус' } as const

let dummyHash: Promise<string> | null = null
/** An unknown login costs as much as a wrong password: the answer does not tell which. */
function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hash('contentops-no-such-person')
  return dummyHash.then((value) => verify(value, password))
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000))

/** 429 while sign-in is closed: the form shows the message, `Retry-After` carries the seconds. */
function closed(waitMs: number): ApiProblem {
  return new ApiProblem(
    'rate_limited',
    `Много неверных попыток: вход закрыт на ${minutes(waitMs)} мин`,
    undefined,
    Math.ceil(waitMs / 1000),
  )
}

interface SignInRow extends Record<string, unknown> {
  id: string
  display_name: string
  password_hash: string | null
  disabled_at: string | null
}

interface SessionRow extends Record<string, unknown> {
  id: string
  user_agent: string | null
  created_at: string
  last_seen_at: string | null
  via_hub: boolean
}

async function liveSessions(services: Services, ctx: RequestContext): Promise<Session[]> {
  const actor = requireActor(ctx)
  const { rows } = await services.db.execute<SessionRow>(sql`
    SELECT id, user_agent, created_at, last_seen_at, hub_grant IS NOT NULL AS via_hub
      FROM sessions
     WHERE principal_id = ${actor.id}::uuid AND revoked_at IS NULL AND expires_at > now()
     ORDER BY coalesce(last_seen_at, created_at) DESC, id DESC`)
  const sessions = rows.map((row) => ({
    id: row.id,
    device: `${deviceOf(row.user_agent)}${row.via_hub ? ' · через хаб' : ''}`,
    last_seen_at: instant(row.last_seen_at ?? row.created_at),
    current: row.id === actor.sessionId,
  }))
  // This browser first.
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)]
}

export function authHandlers(services: Services): HandlerRegistry {
  const { db, command } = services
  // `Secure` over HTTPS: the public address; the tailnet and the VPN of the pilot are plain HTTP.
  const cookieOptions = (ctx: RequestContext) => ({ secure: services.secureCookies || ctx.https })
  const byLogin = new Throttle(LOGIN_RULE)

  /** The session the form opened over Hub's grant: its cookie, and the person as «Войти» answers. */
  async function signedInThroughHub(ctx: RequestContext, token: string) {
    const { rows } = await db.execute<{ principal_id: string }>(sql`
      SELECT principal_id FROM sessions WHERE token_hash = ${sessionDigest(token)}`)
    const principal = rows[0]?.principal_id
    if (!principal) throw new Error('the session just opened is not there')
    ctx.setHeader('Set-Cookie', sessionCookie(token, cookieOptions(ctx)))
    return { person: await personById(db, principal) }
  }

  /** «Выйти» of a session over Hub's grant: Hub ends the session ContentOps' page opened. Best effort. */
  async function endHubSide(sessionId: string, ctx: RequestContext) {
    const hub = services.hubSignin
    if (!hub) return
    const { rows } = await db.execute<{ hub_grant: string | null }>(sql`
      SELECT hub_grant FROM sessions WHERE id = ${sessionId}::uuid`)
    const grant = rows[0]?.hub_grant
    if (!grant) return
    try {
      await hub.setup.hub.signOut(grant)
    } catch (error) {
      ctx.log.warn({ err: error }, 'hub did not take «Выйти»: its session ends by itself')
    }
  }
  const byAddress = new Throttle(ADDRESS_RULE)

  return {
    auth: {
      /** «Войти через хаб» on this name (SPEC §11.1): only the public name, when configured. */
      signInMethods: ({ ctx }) => ({ hub: services.hubSignin?.offeredAt(ctx.host) ?? false }),

      /** No `Idempotency-Key` (SPEC §11.2): a double click must not answer 409. */
      signIn: async ({ body, ctx }) => {
        const login = body.login.trim().toLowerCase()
        const keys = { login: `login:${login}`, address: `address:${ctx.ip}` }
        // A closed key does not check the password: the pause costs the server nothing.
        const wait = Math.max(byLogin.waitMs(keys.login), byAddress.waitMs(keys.address))
        if (wait > 0) throw closed(wait)
        // ContentOps' own entrance (package C4): Hub first — one registry, one account; on Hub's «не подходят» the
        // account of ContentOps itself, as before (people entered here by hand keep their passwords).
        let hubSilent = false
        const hub = services.hubSignin
        if (hub) {
          const outcome = await throughHub(
            db,
            hub,
            () =>
              hub.setup.hub.signIn({
                username: body.login.trim(),
                password: body.password,
                ip: ctx.ip,
                userAgent: ctx.userAgent ?? undefined,
              }),
            {
              id: ctx.requestId,
              ip: ctx.ip,
              userAgent: ctx.userAgent,
              previous: ctx.cookies[SESSION_COOKIE],
            },
            ctx.log,
          )
          if (outcome.kind === 'signed_in') return signedInThroughHub(ctx, outcome.token)
          if (outcome.kind === 'refused' && outcome.reason !== 'wrong')
            throw refusalProblem(outcome.reason)
          hubSilent = outcome.kind === 'unreachable'
        }
        const { rows } = await db.execute<SignInRow>(sql`
          SELECT id, display_name, password_hash, disabled_at FROM principals
           WHERE login = ${login} AND kind = 'human'`)
        const row = rows[0]
        const passwordOk = row?.password_hash
          ? await verify(row.password_hash, body.password)
          : await dummyVerify(body.password)
        if (!row || !passwordOk || row.disabled_at !== null) {
          const pause = Math.max(byLogin.fail(keys.login), byAddress.fail(keys.address))
          // Every checked attempt is journaled (SPEC §11.1), the one that closes sign-in with
          // its pause; an unknown login is not repeated there.
          await withActorTx(
            db,
            { actor: SYSTEM_ACTOR('вход'), action: ctx.route, requestId: ctx.requestId },
            (tx) =>
              logAction(tx, {
                modelId: null,
                subjectKind: 'principals',
                subjectId: row?.id ?? null,
                subjectLabel: row ? login : 'неизвестный логин',
                ...(pause > 0 ? { after: { 'Вход закрыт': `на ${minutes(pause)} мин` } } : {}),
                result: 'denied',
              }),
          )
          if (pause > 0) throw closed(pause)
          // Hub did not answer: its people cannot sign in now, and the form says so, not «не подходят».
          if (hubSilent) throw new ApiProblem('unavailable', HUB_SILENT_WORDS)
          throw new ApiProblem('unauthenticated', 'Логин или пароль не подходят')
        }
        byLogin.clear(keys.login)
        const token = newSecret()
        const previous = ctx.cookies[SESSION_COOKIE]
        const actor = { type: 'human' as const, id: row.id, label: row.display_name }
        await withActorTx(
          db,
          { actor, action: ctx.route, requestId: ctx.requestId },
          async (tx) => {
            const { rows: created } = await tx.execute<{ id: string }>(sql`
            INSERT INTO sessions (principal_id, token_hash, user_agent, expires_at)
            VALUES (${row.id}::uuid, ${sessionDigest(token)}, ${ctx.userAgent},
                    now() + ${`${SESSION_DAYS} days`}::interval)
            RETURNING id`)
            const session = created[0]
            if (!session) throw new Error('session insert returned nothing')
            // Rotation: the session this browser had before is replaced, not left alive.
            if (previous) {
              await tx.execute(sql`
              UPDATE sessions SET revoked_at = now(), replaced_by_id = ${session.id}::uuid
               WHERE token_hash = ${sessionDigest(previous)} AND principal_id = ${row.id}::uuid
                 AND revoked_at IS NULL`)
            }
            await logAction(tx, {
              modelId: null,
              subjectKind: 'principals',
              subjectId: row.id,
              subjectLabel: login,
              after: { Устройство: deviceOf(ctx.userAgent) },
            })
          },
        )
        ctx.setHeader('Set-Cookie', sessionCookie(token, cookieOptions(ctx)))
        return { person: await personById(db, row.id) }
      },

      /**
       * «Придумайте пароль» (package C4): the invitation of a content manager ends here — Hub sets the password in its
       * registry and the person is signed in; «Сегодня» with «Первый день» follows.
       */
      join: async ({ body, ctx }) => {
        const hub = services.hubSignin
        if (!hub) throw new ApiProblem('unavailable', 'Вход по ссылке здесь не настроен')
        const outcome = await throughHub(
          db,
          hub,
          () =>
            hub.setup.hub.setPasswordByLink({
              token: body.token,
              password: body.password,
              ip: ctx.ip,
              userAgent: ctx.userAgent ?? undefined,
            }),
          {
            id: ctx.requestId,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
            previous: ctx.cookies[SESSION_COOKIE],
          },
          ctx.log,
        )
        if (outcome.kind === 'signed_in') return signedInThroughHub(ctx, outcome.token)
        if (outcome.kind === 'refused') throw refusalProblem(outcome.reason)
        throw new ApiProblem('unavailable', HUB_SILENT_WORDS)
      },

      /**
       * «Выйти» (DESIGN §2.1): this browser's session ends. Public, so it always answers and
       * always leaves the «signed out here» mark: the next page load does not sign the person
       * back in through the hub (SPEC §11.1).
       */
      signOut: async ({ ctx }) => {
        const actor = ctx.actor
        if (actor?.type === 'person' && actor.sessionId !== null) {
          const { sessionId } = actor
          // A session the form opened ends in Hub too; one the person opened in Hub stays (Hub decides).
          await endHubSide(sessionId, ctx)
          await withActorTx(
            db,
            {
              actor: { type: 'human', id: actor.id, label: actor.name },
              action: ctx.route,
              requestId: ctx.requestId,
            },
            async (tx) => {
              const revoked = await tx.execute(sql`
                UPDATE sessions SET revoked_at = now()
                 WHERE id = ${sessionId}::uuid AND revoked_at IS NULL`)
              if ((revoked.rowCount ?? 0) === 0) return
              await logAction(tx, {
                modelId: null,
                subjectKind: 'principals',
                subjectId: actor.id,
                subjectLabel: actor.name,
                after: { Устройство: deviceOf(ctx.userAgent) },
              })
            },
          )
        }
        const options = cookieOptions(ctx)
        ctx.setHeader('Set-Cookie', [
          clearedSessionCookie(options),
          ...(services.hubSignin ? [hubMarkCookie('out', options.secure)] : []),
        ])
        return { ok: true as const }
      },

      signOutEverywhere: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const result = await tx.execute(sql`
            UPDATE sessions SET revoked_at = now()
             WHERE principal_id = ${actor.id}::uuid AND revoked_at IS NULL`)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: actor.id,
            subjectLabel: actor.name,
            before: { Сессии: String(result.rowCount ?? 0) },
            after: { Сессии: '0' },
          })
          ctx.setHeader('Set-Cookie', clearedSessionCookie(cookieOptions(ctx)))
          return { ok: true as const }
        }),
    },

    admin: {
      me: async ({ ctx }) => {
        const actor = requireActor(ctx)
        const { rows } = await db.execute<{
          ui_skin: 'blue' | 'focus'
          hub_products: string[] | null
          first_day: boolean
        }>(sql`
          SELECT ui_skin, hub_products,
                 (role = 'manager' AND first_day_closed_at IS NULL) AS first_day
            FROM principals WHERE id = ${actor.id}::uuid`)
        const row = rows[0]
        return {
          person: await personById(db, actor.id),
          models: [...actor.models],
          ui_skin: row?.ui_skin ?? 'blue',
          // The switcher: Hub's list for a person signed in through Hub (products plan §2.1).
          products: productLinks(row?.hub_products ?? null, services.secrets.hubBaseUrl),
          first_day: actor.type === 'person' && row?.first_day === true,
        }
      },
    },

    settings: {
      mySessions: async ({ ctx }) => ({
        items: await liveSessions(services, ctx),
        next_cursor: null,
      }),

      revokeMySession: async ({ params, body, ctx }) => {
        await command({ ctx, body }, async (tx, actor) => {
          if (params.session === actor.sessionId) {
            throw new ApiProblem(
              'invalid_request',
              'Этот браузер закрывается кнопкой «Выйти везде»',
            )
          }
          const { rows } = await tx.execute<SessionRow>(sql`
            UPDATE sessions SET revoked_at = now()
             WHERE id::text = ${params.session} AND principal_id = ${actor.id}::uuid
               AND revoked_at IS NULL AND expires_at > now()
            RETURNING id, user_agent, created_at, last_seen_at, hub_grant IS NOT NULL AS via_hub`)
          const session = rows[0]
          if (!session) throw new ApiProblem('not_found', 'Такой сессии нет')
          await logAction(tx, {
            modelId: null,
            subjectKind: 'sessions',
            subjectId: session.id,
            subjectLabel: deviceOf(session.user_agent),
          })
          return null
        })
        return { items: await liveSessions(services, ctx), next_cursor: null }
      },

      closeFirstDay: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          await tx.execute(sql`
            UPDATE principals SET first_day_closed_at = now()
             WHERE id = ${actor.id}::uuid AND first_day_closed_at IS NULL`)
          return { ok: true as const }
        }),

      updateProfile: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const { rows } = await tx.execute<{ name: string; ui_skin: 'blue' | 'focus' }>(sql`
            SELECT display_name AS name, ui_skin FROM principals
             WHERE id = ${actor.id}::uuid FOR UPDATE`)
          const before = rows[0]
          if (!before) throw new ApiProblem('not_found', 'Такого человека нет')
          const name = body.name ?? before.name
          const skin = body.ui_skin ?? before.ui_skin
          await tx.execute(sql`
            UPDATE principals SET display_name = ${name}, ui_skin = ${skin},
                   row_version = row_version + 1
             WHERE id = ${actor.id}::uuid`)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: actor.id,
            subjectLabel: name,
            before: { Имя: before.name, Вид: SKIN_LABEL[before.ui_skin] },
            after: { Имя: name, Вид: SKIN_LABEL[skin] },
          })
          return personById(tx, actor.id)
        }),

      changePassword: async ({ body, ctx }) => {
        // A session over Hub's grant: the password is Hub's (package C4), changed there; Hub ends every sign-in of
        // the person and signs this one in again — this session goes on with the new grant.
        const actor = requireActor(ctx)
        const hub = services.hubSignin
        const { rows: held } = actor.sessionId
          ? await db.execute<{ hub_grant: string | null }>(sql`
              SELECT hub_grant FROM sessions WHERE id = ${actor.sessionId}::uuid`)
          : { rows: [] }
        const grant = held[0]?.hub_grant ?? null
        if (grant !== null && hub && actor.sessionId) {
          let answer: Awaited<ReturnType<typeof hub.setup.hub.changePassword>>
          try {
            answer = await hub.setup.hub.changePassword({
              grant,
              currentPassword: body.current,
              newPassword: body.next,
              ip: ctx.ip,
              userAgent: ctx.userAgent ?? undefined,
            })
          } catch (error) {
            ctx.log.warn({ err: error }, 'hub did not change the password')
            throw new ApiProblem('unavailable', HUB_SILENT_WORDS)
          }
          if (answer.kind === 'refused') {
            if (answer.reason === 'wrong') {
              throw new ApiProblem('invalid_request', 'Нынешний пароль не подходит', {
                field: 'current',
              })
            }
            if (answer.reason === 'weak') {
              throw new ApiProblem('invalid_request', REFUSAL_WORDS.weak, { field: 'next' })
            }
            throw refusalProblem(answer.reason)
          }
          await withActorTx(
            db,
            {
              actor: { type: 'human', id: actor.id, label: actor.name },
              action: ctx.route,
              requestId: ctx.requestId,
            },
            async (tx) => {
              await tx.execute(sql`
                UPDATE sessions SET hub_grant = ${answer.redeemed.grant}, hub_checked_at = now()
                 WHERE id = ${actor.sessionId}::uuid AND revoked_at IS NULL`)
              await logAction(tx, {
                modelId: null,
                subjectKind: 'principals',
                subjectId: actor.id,
                subjectLabel: actor.name,
                after: { Пароль: 'сменён в Hub' },
              })
            },
          )
          return { ok: true as const }
        }
        return command({ ctx, body }, async (tx, actor) => {
          const { rows } = await tx.execute<{ password_hash: string | null }>(sql`
            SELECT password_hash FROM principals WHERE id = ${actor.id}::uuid FOR UPDATE`)
          const current = rows[0]?.password_hash
          if (!current || !(await verify(current, body.current))) {
            throw new ApiProblem('invalid_request', 'Нынешний пароль не подходит', {
              field: 'current',
            })
          }
          await tx.execute(sql`
            UPDATE principals SET password_hash = ${await hash(body.next)},
                   row_version = row_version + 1
             WHERE id = ${actor.id}::uuid`)
          // Other browsers are signed out; this one stays.
          const revoked = await tx.execute(sql`
            UPDATE sessions SET revoked_at = now()
             WHERE principal_id = ${actor.id}::uuid AND revoked_at IS NULL
               AND id IS DISTINCT FROM ${actor.sessionId}::uuid`)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: actor.id,
            subjectLabel: actor.name,
            after: { 'Другие сессии': `отозваны: ${revoked.rowCount ?? 0}` },
          })
          return { ok: true as const }
        })
      },
    },
  }
}
