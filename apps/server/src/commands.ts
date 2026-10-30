import { createHash } from 'node:crypto'
import type { ConflictDetails } from '@contentops/contracts/domain/errors'
import {
  type Db,
  type Actor as DbActor,
  logAction,
  type Queryable,
  schema,
  type Tx,
  withActorTx,
} from '@contentops/db'
import { and, eq, sql } from 'drizzle-orm'
import type { Actor, RequestContext } from './context'
import { ApiProblem } from './errors'

/** The journal actor of a request (schema §9.3): people are `human` there. */
export function journalActor(actor: Actor): DbActor {
  return { type: actor.type === 'person' ? 'human' : 'agent', id: actor.id, label: actor.name }
}

export function requireActor(ctx: RequestContext): Actor {
  if (!ctx.actor) throw new ApiProblem('unauthenticated', 'Нужно войти')
  return ctx.actor
}

export interface CommandOptions {
  /**
   * The answer carries a secret (an agent token, a temporary password, a session): it is
   * not stored, and a repeat with the same key answers 409 (SPEC §11.2).
   */
  secret?: boolean
}

export interface CommandInput {
  ctx: RequestContext
  body: unknown
}

/** What `command` runs: the domain write and its journal rows, inside one transaction. */
export type CommandRun<T> = (tx: Tx, actor: Actor) => Promise<T>

export type RunCommand = <T>(
  input: CommandInput,
  run: CommandRun<T>,
  options?: CommandOptions,
) => Promise<T>

interface StoredAnswer {
  body: unknown
}

/** Same key, same request: model, method, address, body and the version condition. */
function digestOf(ctx: RequestContext, body: unknown): Buffer {
  const request = [ctx.model?.code ?? null, ctx.method, ctx.url, body ?? null, ctx.ifMatch]
  return createHash('sha256').update(JSON.stringify(request)).digest()
}

const keys = schema.idempotencyKeys

/**
 * The one pipeline of every changing call (SPEC §11.2, schema §3.9):
 *
 * 1. rights are checked before (`authorize`, then the handler's own lookups);
 * 2. the `Idempotency-Key` row is inserted first inside the command transaction, so a
 *    concurrent repeat waits on it and then replays; a rolled-back command frees the key;
 * 3. same key with another request — 409 `idempotency_conflict`; a stored answer is
 *    returned as it was; a secret answer was not stored — 409 «уже выполнено»;
 * 4. only then `run` checks `If-Match`, writes the domain rows and the journal; the answer
 *    is stored in the same transaction.
 *
 * Agents must send a key; people send one from the interface, a call without it just runs.
 */
export function createCommands(db: Db): RunCommand {
  return async <T>(input: CommandInput, run: CommandRun<T>, options: CommandOptions = {}) => {
    const { ctx } = input
    const actor = requireActor(ctx)
    const key = ctx.idempotencyKey
    if (!key && actor.type === 'agent') {
      throw new ApiProblem('invalid_request', 'Нужен ключ повтора (Idempotency-Key)', {
        header: 'Idempotency-Key',
      })
    }
    const journal = { actor: journalActor(actor), action: ctx.route, requestId: ctx.requestId }
    return withActorTx(db, journal, async (tx) => {
      if (!key) return run(tx, actor)
      const digest = digestOf(ctx, input.body)
      const [claimed] = await tx
        .insert(keys)
        .values({
          modelId: ctx.model?.id ?? null,
          principalId: actor.id,
          operation: ctx.route,
          key,
          requestDigest: digest,
          state: options.secret ? 'no_replay' : 'committed',
        })
        .onConflictDoNothing({ target: [keys.principalId, keys.operation, keys.key] })
        .returning({ id: keys.id })
      if (!claimed) return replay<T>(tx, actor.id, ctx.route, key, digest)
      const answer = await run(tx, actor)
      await tx
        .update(keys)
        .set({
          committedAt: sql`now()`,
          ...(options.secret ? {} : { response: { body: answer } satisfies StoredAnswer }),
        })
        .where(eq(keys.id, claimed.id))
      return answer
    })
  }
}

async function replay<T>(
  tx: Tx,
  principalId: string,
  operation: string,
  key: string,
  digest: Buffer,
): Promise<T> {
  const [row] = await tx
    .select({ digest: keys.requestDigest, state: keys.state, response: keys.response })
    .from(keys)
    .where(and(eq(keys.principalId, principalId), eq(keys.operation, operation), eq(keys.key, key)))
  if (!row) throw new Error('idempotency key vanished')
  if (!Buffer.from(row.digest).equals(digest)) {
    throw new ApiProblem('idempotency_conflict', 'Ключ повтора уже использован другим запросом')
  }
  if (row.state === 'no_replay' || !row.response) {
    throw new ApiProblem('idempotency_conflict', 'Уже выполнено — повторите с новым ключом')
  }
  return (row.response as StoredAnswer).body as T
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Ids in paths are UUIDs; anything else cannot exist and is a 404, not a database error. */
export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/** Who changed the subject last, for the 412 line «Диана изменила норму 1 мин назад». */
export async function lastChange(
  q: Queryable,
  subjectKind: string,
  subjectId: string,
): Promise<Pick<ConflictDetails, 'changed_by' | 'changed_by_gender' | 'changed_at'>> {
  const unknown = {
    changed_by: 'Система',
    changed_by_gender: null,
    changed_at: new Date().toISOString(),
  }
  if (!UUID.test(subjectId)) return unknown
  const { rows } = await q.execute<{ label: string; gender: 'f' | 'm' | null; at: string }>(sql`
    SELECT a.actor_label AS label, p.gender, a.at
      FROM action_log a LEFT JOIN principals p ON p.id = a.actor_id
     WHERE a.subject_kind = ${subjectKind} AND a.subject_id = ${subjectId}::uuid
       AND a.entry_kind = 'action' AND a.result = 'ok'
     ORDER BY a.id DESC LIMIT 1`)
  const row = rows[0]
  if (!row) return unknown
  return { changed_by: row.label, changed_by_gender: row.gender, changed_at: instant(row.at) }
}

/** `If-Match` of a change of an existing record: 428 without it, 412 when stale. */
export async function checkVersion(
  q: Queryable,
  ctx: RequestContext,
  current: { version: number; subjectKind: string; subjectId: string; field: string },
  currentValue: () => unknown,
): Promise<void> {
  if (ctx.ifMatch === null) {
    throw new ApiProblem('precondition_required', 'Нужна версия записи (If-Match)')
  }
  if (ctx.ifMatch === current.version) return
  const details: ConflictDetails = {
    ...(await lastChange(q, current.subjectKind, current.subjectId)),
    field: current.field,
    current_version: current.version,
    current_value: currentValue(),
  }
  throw new ApiProblem('version_mismatch', 'Запись уже изменили', details)
}

/** Postgres text of a `timestamptz` (`2026-10-30 12:00:00.123+00`) → ISO 8601 in UTC. */
export function instant(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const iso = value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')
  return new Date(iso).toISOString()
}

export function instantOrNull(value: string | Date | null | undefined): string | null {
  return value === null || value === undefined ? null : instant(value)
}

/**
 * A refused or failed changing call (SPEC §11.2): the command rolled back, so its own
 * transaction writes one `action` row with `denied` (403) or `error`. Calls without an actor
 * (401) and routes the server does not answer yet leave no row.
 */
export function createFailureRecorder(db: Db) {
  return async (ctx: RequestContext, error: unknown): Promise<void> => {
    if (!ctx.actor) return
    const problem = error instanceof ApiProblem ? error : null
    if (problem && ['unauthenticated', 'not_implemented'].includes(problem.code)) return
    const journal = {
      actor: journalActor(ctx.actor),
      action: ctx.route,
      requestId: ctx.requestId,
    }
    await withActorTx(db, journal, (tx) =>
      logAction(tx, {
        modelId: ctx.model?.id ?? null,
        subjectKind: 'request',
        subjectLabel: `${ctx.method} ${ctx.url.split('?')[0]}`,
        after: { code: problem?.code ?? 'internal', status: problem?.status ?? 500 },
        result: problem?.status === 403 ? 'denied' : 'error',
      }),
    )
  }
}
