import type { Session } from '@contentops/contracts/domain/admin'
import { logAction, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { hash, verify } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import {
  clearedSessionCookie,
  deviceOf,
  newSecret,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionCookie,
  sha256,
} from '../auth/secrets'
import { instant, requireActor } from '../commands'
import type { RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { personById } from './people-view'

/** Sign-in, sign-out, the profile and own sessions (DESIGN §4.19 «Профиль и сессии», §4.21). */

const SKIN_LABEL = { blue: 'синий', focus: 'Фокус' } as const

let dummyHash: Promise<string> | null = null
/** An unknown login costs as much as a wrong password: the answer does not tell which. */
function dummyVerify(password: string): Promise<boolean> {
  dummyHash ??= hash('contentops-no-such-person')
  return dummyHash.then((value) => verify(value, password))
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
}

async function liveSessions(services: Services, ctx: RequestContext): Promise<Session[]> {
  const actor = requireActor(ctx)
  const { rows } = await services.db.execute<SessionRow>(sql`
    SELECT id, user_agent, created_at, last_seen_at FROM sessions
     WHERE principal_id = ${actor.id}::uuid AND revoked_at IS NULL AND expires_at > now()
     ORDER BY coalesce(last_seen_at, created_at) DESC, id DESC`)
  const sessions = rows.map((row) => ({
    id: row.id,
    device: deviceOf(row.user_agent),
    last_seen_at: instant(row.last_seen_at ?? row.created_at),
    current: row.id === actor.sessionId,
  }))
  // This browser first.
  return [...sessions.filter((s) => s.current), ...sessions.filter((s) => !s.current)]
}

export function authHandlers(services: Services): HandlerRegistry {
  const { db, command } = services
  const cookieOptions = { secure: services.secureCookies }

  return {
    auth: {
      /** No `Idempotency-Key` (SPEC §11.2): a double click must not answer 409. */
      signIn: async ({ body, ctx }) => {
        const login = body.login.trim().toLowerCase()
        const { rows } = await db.execute<SignInRow>(sql`
          SELECT id, display_name, password_hash, disabled_at FROM principals
           WHERE login = ${login} AND kind = 'human'`)
        const row = rows[0]
        const passwordOk = row?.password_hash
          ? await verify(row.password_hash, body.password)
          : await dummyVerify(body.password)
        if (!row || !passwordOk || row.disabled_at !== null) {
          // Every attempt is journaled (SPEC §11.1); an unknown login is not repeated there.
          await withActorTx(
            db,
            { actor: SYSTEM_ACTOR('вход'), action: ctx.route, requestId: ctx.requestId },
            (tx) =>
              logAction(tx, {
                modelId: null,
                subjectKind: 'principals',
                subjectId: row?.id ?? null,
                subjectLabel: row ? login : 'неизвестный логин',
                result: 'denied',
              }),
          )
          throw new ApiProblem('unauthenticated', 'Логин или пароль не подходят')
        }
        const token = newSecret()
        const previous = ctx.cookies[SESSION_COOKIE]
        const actor = { type: 'human' as const, id: row.id, label: row.display_name }
        await withActorTx(
          db,
          { actor, action: ctx.route, requestId: ctx.requestId },
          async (tx) => {
            const { rows: created } = await tx.execute<{ id: string }>(sql`
            INSERT INTO sessions (principal_id, token_hash, user_agent, expires_at)
            VALUES (${row.id}::uuid, ${sha256(token)}, ${ctx.userAgent},
                    now() + ${`${SESSION_DAYS} days`}::interval)
            RETURNING id`)
            const session = created[0]
            if (!session) throw new Error('session insert returned nothing')
            // Rotation: the session this browser had before is replaced, not left alive.
            if (previous) {
              await tx.execute(sql`
              UPDATE sessions SET revoked_at = now(), replaced_by_id = ${session.id}::uuid
               WHERE token_hash = ${sha256(previous)} AND principal_id = ${row.id}::uuid
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
        ctx.setHeader('Set-Cookie', sessionCookie(token, cookieOptions))
        return { person: await personById(db, row.id) }
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
          ctx.setHeader('Set-Cookie', clearedSessionCookie(cookieOptions))
          return { ok: true as const }
        }),
    },

    admin: {
      me: async ({ ctx }) => {
        const actor = requireActor(ctx)
        const { rows } = await db.execute<{ ui_skin: 'blue' | 'focus' }>(sql`
          SELECT ui_skin FROM principals WHERE id = ${actor.id}::uuid`)
        return {
          person: await personById(db, actor.id),
          models: [...actor.models],
          ui_skin: rows[0]?.ui_skin ?? 'blue',
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
            RETURNING id, user_agent, created_at, last_seen_at`)
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

      changePassword: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
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
        }),
    },
  }
}
