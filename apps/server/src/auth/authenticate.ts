import type { Role } from '@contentops/contracts/domain/people'
import type { Db } from '@contentops/db'
import { sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type { Actor, Authenticate } from '../context'
import { parseCookies } from '../context'
import { SESSION_COOKIE, sha256 } from './secrets'

interface PrincipalRow extends Record<string, unknown> {
  id: string
  role: Role
  display_name: string
  gender: 'f' | 'm' | null
  credential_id: string
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

async function personBySession(db: Db, token: string): Promise<PrincipalRow | undefined> {
  const { rows } = await db.execute<PrincipalRow>(sql`
    SELECT p.id, p.role, p.display_name, p.gender, s.id AS credential_id
      FROM sessions s JOIN principals p ON p.id = s.principal_id
     WHERE s.token_hash = ${sha256(token)}
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
 * `null`, that is 401; rights are read on every request, so a revoke acts at once.
 */
export function createAuthenticate(db: Db): Authenticate {
  return async (request) => {
    const bearer = bearerOf(request)
    if (bearer !== undefined) {
      const agent = bearer ? await agentByToken(db, bearer) : undefined
      if (!agent) return null
      return actorOf(db, 'agent', agent)
    }
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    if (!token) return null
    const person = await personBySession(db, token)
    return person ? actorOf(db, 'person', person) : null
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
