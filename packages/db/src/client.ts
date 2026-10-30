import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as relations from '../drizzle/relations.ts'
import * as tables from '../drizzle/schema.ts'
import type { ActorType, LogResult } from './values.ts'

/** The Drizzle mirror (tables and relations), generated from the migrations. */
export const schema = { ...tables, ...relations }
export type Schema = typeof schema

export type Db = NodePgDatabase<Schema> & { $client: pg.Pool }
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Anything that runs a query: the database or an open transaction. */
export type Queryable = Db | Tx

export interface PoolOptions {
  /** Pool size; default 10. */
  max?: number
  /** Shown in `pg_stat_activity`: the process role (`web`, `worker`, …). */
  applicationName?: string
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

/** node-postgres pool; every session works in UTC (SPEC §12.1). */
export function createPool(url: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'contentops',
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
    options: '-c TimeZone=UTC',
  })
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema })
}

/** Who acts: a person, an agent (both principals) or the system itself. */
export interface Actor {
  type: ActorType
  /** Principal id; `null` only for `system`. */
  id: string | null
  /** Name in the feed: «Диана», «агент приёмки», «bootstrap». */
  label: string
}

/** Journal context of one transaction (schema §9.3). */
export interface JournalContext {
  actor: Actor
  /** Action name: `settings.week_norm.set`, `work.attempt`. */
  action: string
  /** Same id as the API response (`request_id`). */
  requestId: string
  /** Object whose changes follow; switch with `setJournalItem`. */
  itemId?: string | null
  workId?: string | null
}

export const SYSTEM_ACTOR = (label: string): Actor => ({ type: 'system', id: null, label })

/**
 * Runs `fn` in a transaction that carries the journal context: without it the journal
 * trigger rejects every write to a mutable table.
 */
export async function withActorTx<T>(
  db: Db,
  context: JournalContext,
  fn: (tx: Tx) => Promise<T>,
  config?: Parameters<Db['transaction']>[1],
): Promise<T> {
  checkContext(context)
  return db.transaction(async (tx) => {
    await setJournalContext(tx, context)
    return fn(tx)
  }, config)
}

/** `SET LOCAL app.*` for an already open transaction. */
export async function setJournalContext(tx: Tx, context: JournalContext): Promise<void> {
  checkContext(context)
  await tx.execute(sql`SELECT
    set_config('app.actor_type', ${context.actor.type}, true),
    set_config('app.actor_id', ${context.actor.id ?? ''}, true),
    set_config('app.actor_label', ${context.actor.label}, true),
    set_config('app.action', ${context.action}, true),
    set_config('app.request_id', ${context.requestId}, true),
    set_config('app.item_id', ${context.itemId ?? ''}, true),
    set_config('app.work_id', ${context.workId ?? ''}, true)`)
}

/** Set before the changes of each object: trigger rows carry its `item_id`. */
export async function setJournalItem(tx: Tx, itemId: string | null): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.item_id', ${itemId ?? ''}, true)`)
}

/** A typed `action` row: one line of the feed and «История» (schema §9.3). */
export interface ActionEvent {
  modelId: string | null
  subjectKind: string
  subjectId?: string | null
  subjectLabel: string
  /** Defaults to the action of the journal context. */
  action?: string
  itemId?: string | null
  workId?: string | null
  before?: unknown
  after?: unknown
  result?: LogResult
}

/**
 * Writes an `action` row with the actor of the transaction's journal context.
 * Denials and errors are written after the rollback, in a transaction of their own.
 */
export async function logAction(tx: Tx, event: ActionEvent): Promise<void> {
  await tx.execute(sql`INSERT INTO action_log (
      model_id, actor_type, actor_id, actor_label, action, entry_kind, item_id, request_id,
      work_id, subject_kind, subject_id, subject_label, before, after, result
    ) VALUES (
      ${event.modelId}::uuid,
      nullif(current_setting('app.actor_type'), ''),
      nullif(current_setting('app.actor_id'), '')::uuid,
      nullif(current_setting('app.actor_label'), ''),
      coalesce(${event.action ?? null}, nullif(current_setting('app.action'), '')),
      'action',
      coalesce(${event.itemId ?? null}::uuid, nullif(current_setting('app.item_id', true), '')::uuid),
      nullif(current_setting('app.request_id'), ''),
      coalesce(${event.workId ?? null}::uuid, nullif(current_setting('app.work_id', true), '')::uuid),
      ${event.subjectKind},
      ${event.subjectId ?? null}::uuid,
      ${event.subjectLabel},
      ${jsonParam(event.before)}::jsonb,
      ${jsonParam(event.after)}::jsonb,
      ${event.result ?? 'ok'}
    )`)
}

function jsonParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function checkContext(context: JournalContext): void {
  const { actor } = context
  if (!actor.label.trim()) throw new Error('journal context: empty actor label')
  if (!context.action.trim()) throw new Error('journal context: empty action')
  if (!context.requestId.trim()) throw new Error('journal context: empty request id')
  if (actor.type !== 'system' && !actor.id) {
    throw new Error(`journal context: a ${actor.type} needs a principal id`)
  }
}

/** SQLSTATE of a database error, also when Drizzle wraps it (`DrizzleQueryError.cause`). */
export function dbErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
  }
  return undefined
}
