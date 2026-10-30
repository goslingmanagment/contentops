import type { Gender } from '@contentops/contracts/domain/common'
import { ROLE_LABEL } from '@contentops/contracts/domain/people'
import { logAction, type Tx } from '@contentops/db'
import { hash } from '@node-rs/argon2'
import { sql } from 'drizzle-orm'
import { temporaryPassword } from '../auth/secrets'
import { checkVersion, instant, isUuid } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { changesOf } from '../journal/describe'
import type { Services } from '../services'
import { listPeople, personById } from './people-view'
import { modelNames, modelsByCodes, withFieldErrors } from './shared'

/** «Люди и доступ» (DESIGN §4.19): роль, модели галочками, сессии, история выдачи прав. */

/** Male names that end in «а» or «я» like feminine ones. */
const MALE_NAMES_IN_A = new Set(['никита', 'илья', 'лука', 'фома', 'кузьма', 'савва', 'данила'])

/**
 * The form asks only the name; the verb of the feed needs a gender (schema §3.1): Russian
 * names in «а»/«я» are feminine except the male ones above. The owner can be wrong only in
 * a verb ending.
 */
export function genderOfName(name: string): Gender {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return /[ая]$/.test(first) && !MALE_NAMES_IN_A.has(first) ? 'f' : 'm'
}

interface RightsRow extends Record<string, unknown> {
  id: string
  name: string
  role: keyof typeof ROLE_LABEL
  version: number | string
}

/** The person row under a lock: changes of one person's rights go one after another. */
async function lockPerson(tx: Tx, id: string): Promise<RightsRow> {
  if (!isUuid(id)) throw new ApiProblem('not_found', 'Такого человека нет')
  const { rows } = await tx.execute<RightsRow>(sql`
    SELECT id, display_name AS name, role, row_version AS version FROM principals
     WHERE id = ${id}::uuid AND kind = 'human' AND disabled_at IS NULL FOR UPDATE`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такого человека нет')
  return row
}

/** Live grants become exactly `codes`: removed ones are revoked, new ones granted. */
async function setGrants(tx: Tx, principalId: string, codes: readonly string[], by: string) {
  const wanted = await modelsByCodes(tx, codes)
  await tx.execute(sql`
    UPDATE principal_grants SET revoked_at = now()
     WHERE principal_id = ${principalId}::uuid AND revoked_at IS NULL
       AND NOT (model_id = ANY(${sql.param(wanted.map((model) => model.id))}::uuid[]))`)
  for (const model of wanted) {
    await tx.execute(sql`
      INSERT INTO principal_grants (model_id, principal_id, granted_by)
      VALUES (${model.id}::uuid, ${principalId}::uuid, ${by}::uuid)
      ON CONFLICT (principal_id, model_id) WHERE revoked_at IS NULL DO NOTHING`)
  }
}

export function peopleHandlers({ db, command }: Services): HandlerRegistry {
  return {
    admin: {
      people: async () => ({ items: await listPeople(db), next_cursor: null }),
    },
    settings: {
      addPerson: ({ body, ctx }) =>
        command(
          { ctx, body },
          async (tx, actor) => {
            const password = temporaryPassword()
            const models = await modelsByCodes(tx, body.models)
            const id = await withFieldErrors(
              async () => {
                const { rows } = await tx.execute<{ id: string }>(sql`
                  INSERT INTO principals (kind, login, display_name, gender, role, password_hash)
                  VALUES ('human', ${body.login.toLowerCase()}, ${body.name},
                          ${genderOfName(body.name)}, ${body.role}, ${await hash(password)})
                  RETURNING id`)
                return rows[0]?.id
              },
              {
                principals_login_key: { field: 'login', message: 'Такой логин уже есть' },
                principals_login_format: { field: 'login', message: 'Неверный логин' },
              },
            )
            if (!id) throw new Error('principal insert returned nothing')
            await setGrants(
              tx,
              id,
              models.map((model) => model.code),
              actor.id,
            )
            const person = await personById(tx, id)
            await logAction(tx, {
              modelId: null,
              subjectKind: 'principals',
              subjectId: id,
              subjectLabel: body.name,
              after: {
                Логин: person.login,
                Роль: ROLE_LABEL[person.role],
                Модели: await modelNames(tx, person.models),
              },
            })
            return { person, temporary_password: password }
          },
          { secret: true },
        ),

      updatePerson: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const row = await lockPerson(tx, params.person)
          const before = await personById(tx, row.id)
          await checkVersion(
            tx,
            ctx,
            {
              version: Number(row.version),
              subjectKind: 'principals',
              subjectId: row.id,
              field: `права ${row.name}`,
            },
            () => ({ role: before.role, models: before.models }),
          )
          const role = body.role ?? before.role
          if (row.id === actor.id && role !== before.role) {
            throw new ApiProblem('forbidden', 'Свою роль не меняют')
          }
          if (body.models) await setGrants(tx, row.id, body.models, actor.id)
          await tx.execute(sql`
            UPDATE principals SET role = ${role}, row_version = row_version + 1
             WHERE id = ${row.id}::uuid`)
          const after = await personById(tx, row.id)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: row.id,
            subjectLabel: row.name,
            before: { Роль: ROLE_LABEL[before.role], Модели: await modelNames(tx, before.models) },
            after: { Роль: ROLE_LABEL[after.role], Модели: await modelNames(tx, after.models) },
          })
          return after
        }),

      revokePersonSessions: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const row = await lockPerson(tx, params.person)
          const revoked = await tx.execute(sql`
            UPDATE sessions SET revoked_at = now()
             WHERE principal_id = ${row.id}::uuid AND revoked_at IS NULL AND expires_at > now()`)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: row.id,
            subjectLabel: row.name,
            before: { Сессии: String(revoked.rowCount ?? 0) },
            after: { Сессии: '0' },
          })
          return personById(tx, row.id)
        }),

      revokeAccess: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const row = await lockPerson(tx, params.person)
          if (row.id === actor.id) throw new ApiProblem('forbidden', 'Свой доступ не отзывают')
          // The person can no longer sign in; sessions and grants end at once.
          await tx.execute(sql`
            UPDATE principals SET disabled_at = now(), row_version = row_version + 1
             WHERE id = ${row.id}::uuid`)
          await tx.execute(sql`
            UPDATE sessions SET revoked_at = now()
             WHERE principal_id = ${row.id}::uuid AND revoked_at IS NULL`)
          await tx.execute(sql`
            UPDATE principal_grants SET revoked_at = now()
             WHERE principal_id = ${row.id}::uuid AND revoked_at IS NULL`)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: row.id,
            subjectLabel: row.name,
            before: { Доступ: ROLE_LABEL[row.role] },
            after: { Доступ: 'нет' },
          })
          return { ok: true as const }
        }),

      /** History of rights: the journal rows of this person's rights. */
      personGrants: async ({ params }) => {
        const person = await personById(db, params.person)
        const { rows } = await db.execute<{
          at: string
          by: string
          before: unknown
          after: unknown
        }>(sql`
          SELECT at, actor_label AS by, before, after FROM action_log
           WHERE subject_kind = 'principals' AND subject_id = ${person.id}::uuid
             AND entry_kind = 'action' AND result = 'ok'
             AND action IN ('settings.addPerson', 'settings.updatePerson',
                            'settings.revokeAccess', 'principal.create')
           ORDER BY id DESC`)
        return {
          items: rows.flatMap((row) => {
            const changes = changesOf(row.before, row.after).filter((c) => c.field !== 'Логин')
            if (changes.length === 0) return []
            const text = changes
              .map((c) =>
                c.before === '—'
                  ? `${c.field}: ${c.after}`
                  : `${c.field}: ${c.before} → ${c.after}`,
              )
              .join(' · ')
            return [{ at: instant(row.at), by: row.by, text }]
          }),
          next_cursor: null,
        }
      },

      /** Names for «обычно выкладывает» (DESIGN §4.14): people with rights on the model. */
      modelPeople: async ({ ctx }) => {
        const model = ctx.model
        if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
        const { rows } = await db.execute<{ id: string; name: string }>(sql`
          SELECT p.id, p.display_name AS name FROM principals p
           WHERE p.kind = 'human' AND p.disabled_at IS NULL
             AND (p.role = 'owner' OR EXISTS (
                   SELECT 1 FROM principal_grants g
                    WHERE g.principal_id = p.id AND g.model_id = ${model.id}::uuid
                      AND g.revoked_at IS NULL))
           ORDER BY p.display_name, p.id`)
        return { items: rows, next_cursor: null }
      },
    },
  }
}
