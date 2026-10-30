import type { Agent, AgentToken } from '@contentops/contracts/domain/agents'
import { logAction, type Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { newSecret, sha256, TOKEN_PREFIX, TOKEN_PREFIX_LENGTH } from '../auth/secrets'
import { instant, instantOrNull, isUuid } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'

/** «Агенты и токены» (DESIGN §4.19): токен показывается один раз, хранится его хэш. */

interface AgentRow extends Record<string, unknown> {
  id: string
  name: string
  role: Agent['role']
  models: string[]
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
    SELECT p.id, p.display_name AS name, p.role,
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
  }))
}

async function agentById(q: Queryable, id: string): Promise<Agent> {
  const [agent] = isUuid(id) ? await agents(q, id) : []
  if (!agent) throw new ApiProblem('not_found', 'Такого агента нет')
  return agent
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
  }
}
