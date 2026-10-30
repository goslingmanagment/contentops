import { randomUUID } from 'node:crypto'
import type { Agent, AgentToken } from '@contentops/contracts/domain/agents'
import { ROLE_LABEL } from '@contentops/contracts/domain/people'
import { logAction, type Queryable, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { newSecret, sha256, TOKEN_PREFIX, TOKEN_PREFIX_LENGTH } from '../auth/secrets'
import { checkVersion, instant, instantOrNull, isUuid } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { modelNames, modelsByCodes, setGrants } from './shared'

/**
 * «Агенты и токены» (DESIGN §4.19): агент — принципал с ролью и моделями, как человек
 * (SPEC §11.1); токен показывается один раз, хранится его хэш.
 */

interface AgentRow extends Record<string, unknown> {
  id: string
  name: string
  role: Agent['role']
  models: string[]
  version: number | string
}

interface TokenRow extends Record<string, unknown> {
  id: string
  principal_id: string
  token_prefix: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
}

function tokenOf(row: TokenRow): AgentToken {
  return {
    id: row.id,
    prefix: row.token_prefix,
    issued_at: instant(row.created_at),
    expires_at: instantOrNull(row.expires_at),
    last_used_at: instantOrNull(row.last_used_at),
    revoked_at: instantOrNull(row.revoked_at),
  }
}

async function agents(q: Queryable, id?: string): Promise<Agent[]> {
  const { rows } = await q.execute<AgentRow>(sql`
    SELECT p.id, p.display_name AS name, p.role, p.row_version AS version,
           CASE WHEN p.role = 'owner'
             THEN coalesce((SELECT array_agg(m.code ORDER BY m.id) FROM models m
                             WHERE m.archived_at IS NULL), '{}')
             ELSE coalesce((SELECT array_agg(m.code ORDER BY m.id)
                              FROM principal_grants g JOIN models m ON m.id = g.model_id
                             WHERE g.principal_id = p.id AND g.revoked_at IS NULL
                               AND m.archived_at IS NULL), '{}')
           END AS models
      FROM principals p
     WHERE p.kind = 'agent' AND p.disabled_at IS NULL
       AND (${id ?? null}::uuid IS NULL OR p.id = ${id ?? null}::uuid)
     ORDER BY p.id`)
  if (rows.length === 0) return []
  const { rows: tokens } = await q.execute<TokenRow>(sql`
    SELECT id, principal_id, token_prefix, created_at, expires_at, last_used_at, revoked_at
      FROM api_tokens WHERE principal_id = ANY(${sql.param(rows.map((row) => row.id))}::uuid[])
     ORDER BY created_at, id`)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    models: row.models,
    tokens: tokens.filter((token) => token.principal_id === row.id).map(tokenOf),
    version: Number(row.version),
  }))
}

async function agentById(q: Queryable, id: string): Promise<Agent> {
  const [agent] = isUuid(id) ? await agents(q, id) : []
  if (!agent) throw new ApiProblem('not_found', 'Такого агента нет')
  return agent
}

/** The agent row under a lock: changes of one agent go one after another. */
async function lockAgent(
  tx: Tx,
  id: string,
): Promise<{ id: string; name: string; version: number }> {
  if (!isUuid(id)) throw new ApiProblem('not_found', 'Такого агента нет')
  const { rows } = await tx.execute<{ id: string; name: string; version: number | string }>(sql`
    SELECT id, display_name AS name, row_version AS version FROM principals
     WHERE id = ${id}::uuid AND kind = 'agent' AND disabled_at IS NULL FOR UPDATE`)
  const row = rows[0]
  if (!row) throw new ApiProblem('not_found', 'Такого агента нет')
  return { id: row.id, name: row.name, version: Number(row.version) }
}

/** What the journal shows of an agent: «было → стало» by these fields. */
async function snapshotOf(q: Queryable, agent: Agent): Promise<Record<string, string>> {
  return {
    Имя: agent.name,
    Роль: ROLE_LABEL[agent.role],
    Модели: await modelNames(q, agent.models),
  }
}

export function agentHandlers({ db, command }: Services): HandlerRegistry {
  return {
    admin: {
      agents: async () => ({ items: await agents(db), next_cursor: null }),

      issueToken: ({ params, body, ctx }) =>
        command(
          { ctx, body },
          async (tx) => {
            const agent = await agentById(tx, params.agent)
            const secret = newSecret(TOKEN_PREFIX)
            const days = body.expires_in_days
            const { rows } = await tx.execute<TokenRow>(sql`
              INSERT INTO api_tokens (principal_id, name, token_hash, token_prefix, expires_at)
              VALUES (${agent.id}::uuid, ${agent.name}, ${sha256(secret)},
                      ${secret.slice(0, TOKEN_PREFIX_LENGTH)},
                      CASE WHEN ${days}::int IS NULL THEN NULL
                           ELSE now() + make_interval(days => ${days}::int) END)
              RETURNING id, principal_id, token_prefix, created_at, expires_at, last_used_at,
                        revoked_at`)
            const row = rows[0]
            if (!row) throw new Error('token insert returned nothing')
            await logAction(tx, {
              modelId: null,
              subjectKind: 'api_tokens',
              subjectId: row.id,
              subjectLabel: agent.name,
              after: {
                Токен: `${row.token_prefix}…`,
                Срок: days ? `${days} дн.` : 'бессрочно',
              },
            })
            return { token: tokenOf(row), secret }
          },
          { secret: true },
        ),

      revokeToken: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx) => {
          const agent = await agentById(tx, params.agent)
          if (!isUuid(params.token)) throw new ApiProblem('not_found', 'Такого токена нет')
          const { rows } = await tx.execute<TokenRow>(sql`
            SELECT id, principal_id, token_prefix, created_at, expires_at, last_used_at, revoked_at
              FROM api_tokens
             WHERE id = ${params.token}::uuid AND principal_id = ${agent.id}::uuid FOR UPDATE`)
          const token = rows[0]
          if (!token) throw new ApiProblem('not_found', 'Такого токена нет')
          if (token.revoked_at === null) {
            await tx.execute(
              sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${token.id}::uuid`,
            )
            await logAction(tx, {
              modelId: null,
              subjectKind: 'api_tokens',
              subjectId: token.id,
              subjectLabel: agent.name,
              before: { Токен: `${token.token_prefix}… · действует` },
              after: { Токен: `${token.token_prefix}… · отозван` },
            })
          }
          return agentById(tx, agent.id)
        }),
    },
    settings: {
      addAgent: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const models = await modelsByCodes(tx, body.models)
          // Agents do not sign in: the login only keeps the column unique.
          const { rows } = await tx.execute<{ id: string }>(sql`
            INSERT INTO principals (kind, login, display_name, role)
            VALUES ('agent', ${`agent-${randomUUID()}`}, ${body.name}, ${body.role})
            RETURNING id`)
          const id = rows[0]?.id
          if (!id) throw new Error('agent insert returned nothing')
          await setGrants(
            tx,
            id,
            models.map((model) => model.code),
            actor.id,
          )
          const agent = await agentById(tx, id)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: id,
            subjectLabel: agent.name,
            after: await snapshotOf(tx, agent),
          })
          return agent
        }),

      updateAgent: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const row = await lockAgent(tx, params.agent)
          const before = await agentById(tx, row.id)
          await checkVersion(
            tx,
            ctx,
            {
              version: row.version,
              subjectKind: 'principals',
              subjectId: row.id,
              field: `агента ${row.name}`,
            },
            () => ({ name: before.name, role: before.role, models: before.models }),
          )
          if (body.models) await setGrants(tx, row.id, body.models, actor.id)
          await tx.execute(sql`
            UPDATE principals
               SET display_name = ${body.name ?? before.name}, role = ${body.role ?? before.role},
                   row_version = row_version + 1
             WHERE id = ${row.id}::uuid`)
          const after = await agentById(tx, row.id)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'principals',
            subjectId: row.id,
            subjectLabel: after.name,
            before: await snapshotOf(tx, before),
            after: await snapshotOf(tx, after),
          })
          return after
        }),
    },
  }
}
