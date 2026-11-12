import type { Role } from '@contentops/contracts/domain/people'
import type { Db } from '@contentops/db'
import { HUB_AGENT_KEY_PREFIX } from '@contentops/hub'
import { sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { Actor, Authenticate } from '../context'
import { parseCookies } from '../context'
import { ApiProblem } from '../errors'
import type { HubAgentKeyService } from './hub-agent-keys'
import type { HubSessions } from './hub-signin'
import { SESSION_COOKIE, sessionDigest, sha256 } from './secrets'

interface AgentRow extends Record<string, unknown> {
  id: string
  role: Role
  display_name: string
  gender: 'f' | 'm' | null
}

interface PrincipalRow extends AgentRow {
  credential_id: string
}

interface SessionRow extends PrincipalRow {
  login: string
  hub_user_id: string | null
  /** A session opened through the hub; null — by password. */
  hub_grant: string | null
  hub_checked_ms: number | null
}

/** `last_seen_at` and `last_used_at` move at most this often: a mark, not a log. */
const SEEN_EVERY = "interval '5 minutes'"

/** Codes of the models the principal may see now: the owner sees every model. */
export async function modelsOf(db: Db, principalId: string, role: Role): Promise<string[]> {
  const { rows } = await db.execute<{ code: string }>(sql`
    SELECT m.code FROM models m
     WHERE m.archived_at IS NULL
       AND (${role} = 'owner' OR EXISTS (
             SELECT 1 FROM principal_grants g
              WHERE g.model_id = m.id AND g.principal_id = ${principalId}::uuid
                AND g.revoked_at IS NULL))
     ORDER BY m.id`)
  return rows.map((row) => row.code)
}

function bearerOf(request: FastifyRequest): string | null | undefined {
  const header = request.headers.authorization
  if (header === undefined) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1] ?? null
}

async function agentByToken(db: Db, token: string): Promise<PrincipalRow | undefined> {
  const { rows } = await db.execute<PrincipalRow>(sql`
    SELECT p.id, p.role, p.display_name, p.gender, t.id AS credential_id
      FROM api_tokens t JOIN principals p ON p.id = t.principal_id
     WHERE t.token_hash = ${sha256(token)}
       AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
       AND p.kind = 'agent' AND p.disabled_at IS NULL`)
  const row = rows[0]
  if (row) {
    await db.execute(sql`UPDATE api_tokens SET last_used_at = now()
      WHERE id = ${row.credential_id}::uuid
        AND (last_used_at IS NULL OR last_used_at < now() - ${sql.raw(SEEN_EVERY)})`)
  }
  return row
}

/** The local agent a hub agent's code is linked to (`principals.hub_agent_code`, set by the owner). */
async function agentByHubCode(db: Db, code: string): Promise<AgentRow | undefined> {
  const { rows } = await db.execute<AgentRow>(sql`
    SELECT p.id, p.role, p.display_name, p.gender FROM principals p
     WHERE p.hub_agent_code = ${code} AND p.kind = 'agent' AND p.disabled_at IS NULL`)
  return rows[0]
}

/**
 * An agent's Agency Hub key (ecosystem package M2): Hub says whose key it is, the owner's link
 * says which local agent it acts as — its role, its models, its switch, its journal. A code
 * without a link gets nothing. Every such call is written to `hub_agent_calls` under the code.
 */
async function agentByHubKey(
  db: Db,
  keys: HubAgentKeyService,
  token: string,
  request: FastifyRequest,
): Promise<Actor> {
  const verdict = await keys.who(token)
  if (verdict.kind === 'unreachable') {
    throw new ApiProblem(
      'unavailable',
      'Ключ хаба не проверить: хаб не отвечает, а последнего ответа о ключе нет или ему больше часа',
    )
  }
  if (verdict.kind === 'refused') {
    throw new ApiProblem('unavailable', 'Ключ хаба не проверить: хаб отказал ContentOps в ответе')
  }
  if (verdict.kind === 'inactive') {
    throw new ApiProblem(
      'unauthenticated',
      'Ключ хаба не действует: отозван, истёк или не принадлежит агенту',
    )
  }
  const agent = await agentByHubCode(db, verdict.code)
  await db.execute(sql`
    INSERT INTO hub_agent_calls (agent_code, principal_id, method, url, request_id, outcome, held)
    VALUES (${verdict.code}, ${agent?.id ?? null}::uuid, ${request.method},
            ${request.url.slice(0, 1024)}, ${request.id}, ${agent ? 'ok' : 'not_linked'},
            ${verdict.held})`)
  if (!agent) {
    throw new ApiProblem('forbidden', `Агент хаба ${verdict.code} не связан с агентом ContentOps`)
  }
  return {
    type: 'agent',
    id: agent.id,
    role: agent.role,
    models: await modelsOf(db, agent.id, agent.role),
    name: agent.display_name,
    gender: agent.gender,
    sessionId: null,
    tokenId: null,
    hubAgent: verdict.code,
  }
}

async function personBySession(db: Db, token: string): Promise<SessionRow | undefined> {
  const { rows } = await db.execute<SessionRow>(sql`
    SELECT p.id, p.role, p.display_name, p.gender, s.id AS credential_id, p.login,
           p.hub_user_id::text AS hub_user_id, s.hub_grant,
           (extract(epoch FROM s.hub_checked_at) * 1000)::float8 AS hub_checked_ms
      FROM sessions s JOIN principals p ON p.id = s.principal_id
     WHERE s.token_hash = ${sessionDigest(token)}
       AND s.revoked_at IS NULL AND s.expires_at > now()
       AND p.kind = 'human' AND p.disabled_at IS NULL`)
  const row = rows[0]
  if (row) {
    await db.execute(sql`UPDATE sessions SET last_seen_at = now()
      WHERE id = ${row.credential_id}::uuid
        AND (last_seen_at IS NULL OR last_seen_at < now() - ${sql.raw(SEEN_EVERY)})`)
  }
  return row
}

/**
 * The caller of a request (SPEC §11.1, §12.0): `Authorization: Bearer` for agents, the
 * session cookie for people. Revoked or expired credentials and disabled principals give
 * `null`, that is 401; rights are read on every request, so a revoke acts at once. A session
 * opened through the hub also needs the hub's «still signed in» (`hubSessions`); without the
 * hub sign-in configured such a session is refused. An agent's hub key (`agency_hub_agent_…`)
 * is asked about at the hub (`hubAgentKeys`); without ContentOps' own key for that it is just an
 * unknown token, 401.
 */
export function createAuthenticate(
  db: Db,
  hubSessions: HubSessions | null = null,
  hubAgentKeys: HubAgentKeyService | null = null,
): Authenticate {
  return async (request) => {
    const bearer = bearerOf(request)
    if (bearer !== undefined) {
      if (bearer && hubAgentKeys && bearer.startsWith(HUB_AGENT_KEY_PREFIX)) {
        return agentByHubKey(db, hubAgentKeys, bearer, request)
      }
      const agent = bearer ? await agentByToken(db, bearer) : undefined
      if (!agent) return null
      return actorOf(db, 'agent', agent)
    }
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (!token) return null
    const person = await personBySession(db, token)
    if (!person) return null
    if (person.hub_grant !== null) {
      const alive = hubSessions
        ? await hubSessions.stillSignedIn(
            {
              sessionId: person.credential_id,
              principalId: person.id,
              login: person.login,
              hubUserId: person.hub_user_id,
              grant: person.hub_grant,
              checkedAtMs: person.hub_checked_ms,
            },
            request,
          )
        : false
      if (!alive) return null
    }
    return actorOf(db, 'person', person)
  }
}

async function actorOf(db: Db, type: Actor['type'], row: PrincipalRow): Promise<Actor> {
  return {
    type,
    id: row.id,
    role: row.role,
    models: await modelsOf(db, row.id, row.role),
    name: row.display_name,
    gender: row.gender,
    sessionId: type === 'person' ? row.credential_id : null,
    tokenId: type === 'agent' ? row.credential_id : null,
  }
}
