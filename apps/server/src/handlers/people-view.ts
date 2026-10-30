import type { Person } from '@contentops/contracts/domain/people'
import type { Queryable } from '@contentops/db'
import { type SQL, sql } from 'drizzle-orm'
import { instantOrNull, isUuid } from '../commands'
import { ApiProblem } from '../errors'

interface PersonRow extends Record<string, unknown> {
  id: string
  name: string
  login: string
  gender: 'f' | 'm'
  role: Person['role']
  version: number | string
  sessions: number
  last_seen_at: string | null
  posts_on: Person['posts_on']
  models: string[]
}

/** «Люди и доступ»: people, not agents; a person whose access was revoked is gone. */
function peopleQuery(where: SQL) {
  return sql<PersonRow>`
    SELECT p.id, p.display_name AS name, p.login, p.gender, p.role, p.row_version AS version,
           (SELECT count(*)::int FROM sessions s
             WHERE s.principal_id = p.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions,
           (SELECT max(coalesce(s.last_seen_at, s.created_at)) FROM sessions s
             WHERE s.principal_id = p.id) AS last_seen_at,
           coalesce((SELECT array_agg(DISTINCT a.platform ORDER BY a.platform) FROM accounts a
                      WHERE a.default_assignee_id = p.id AND a.archived_at IS NULL), '{}') AS posts_on,
           CASE WHEN p.role = 'owner'
             THEN coalesce((SELECT array_agg(m.code ORDER BY m.id) FROM models m
                             WHERE m.archived_at IS NULL), '{}')
             ELSE coalesce((SELECT array_agg(m.code ORDER BY m.id)
                              FROM principal_grants g JOIN models m ON m.id = g.model_id
                             WHERE g.principal_id = p.id AND g.revoked_at IS NULL
                               AND m.archived_at IS NULL), '{}')
           END AS models
      FROM principals p
     WHERE p.kind = 'human' AND p.disabled_at IS NULL AND ${where}
     ORDER BY p.id`
}

function personOf(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    login: row.login,
    gender: row.gender,
    role: row.role,
    models: row.models,
    posts_on: row.posts_on,
    sessions: row.sessions,
    last_seen_at: instantOrNull(row.last_seen_at),
    version: Number(row.version),
  }
}

export async function listPeople(q: Queryable): Promise<Person[]> {
  const { rows } = await q.execute<PersonRow>(peopleQuery(sql`true`))
  return rows.map(personOf)
}

export async function findPerson(q: Queryable, id: string): Promise<Person | undefined> {
  if (!isUuid(id)) return undefined
  const { rows } = await q.execute<PersonRow>(peopleQuery(sql`p.id = ${id}::uuid`))
  return rows[0] ? personOf(rows[0]) : undefined
}

export async function personById(q: Queryable, id: string): Promise<Person> {
  const person = await findPerson(q, id)
  if (!person) throw new ApiProblem('not_found', 'Такого человека нет')
  return person
}
