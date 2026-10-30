import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { sql } from 'drizzle-orm'
import { type Db, logAction, SYSTEM_ACTOR, type Tx, withActorTx } from '../client.ts'
import {
  type FailureKind,
  type WorkKind,
  type WorkRole,
  type WorkSlot,
  workKindRole,
  workKindSlot,
  workKindsByRole,
} from '../values.ts'
import { toWorkRow, type WorkRow } from './row.ts'

/** A handler failure; anything else thrown counts as `transient`. */
export class WorkError extends Error {
  readonly kind: FailureKind
  readonly code: string
  /** Wait at least this long before the next attempt (429 with Retry-After). */
  readonly retryAfterMs: number | undefined

  constructor(
    kind: FailureKind,
    code: string,
    message: string,
    options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'WorkError'
    this.kind = kind
    this.code = code
    this.retryAfterMs = options.retryAfterMs
  }
}

/** This holder no longer owns the work: another took it after the lease expired. */
export class LeaseLostError extends Error {
  constructor(workId: string) {
    super(`lease of work ${workId} is lost`)
    this.name = 'LeaseLostError'
  }
}

/**
 * The work waits for another one (an issue waiting for its copies): it goes back to the
 * queue without counting an attempt and is due again after `afterMs`.
 */
export class WorkDeferred extends Error {
  readonly afterMs: number
  readonly note: string

  constructor(afterMs: number, note: string) {
    super(`deferred: ${note}`)
    this.name = 'WorkDeferred'
    this.afterMs = afterMs
    this.note = note
  }
}

/** The runner is stopping; the work goes back to the queue without counting an attempt. */
export class RunnerStoppedError extends Error {
  constructor() {
    super('work runner is stopping')
    this.name = 'RunnerStoppedError'
  }
}

export interface WorkContext {
  /** The row as claimed: attempt, generation, checkpoint of the previous attempt. */
  work: WorkRow
  /** Aborted when the lease is lost or the runner stops; long steps must listen to it. */
  signal: AbortSignal
  db: Db
  /** Saves progress and a checkpoint under the lease; throws `LeaseLostError` when it is gone. */
  checkpoint(update: {
    checkpoint?: unknown
    progress?: { num: number; den?: number | null; note?: string | null }
  }): Promise<void>
}

export interface WorkSuccess {
  outputSha256?: Buffer | null
  outputRef?: string | null
  /** Final report of the run; never changes after success. */
  report?: unknown
  /**
   * Domain writes of the result. They run in the transaction that finishes the work, only
   * while this holder still owns the current generation: a stale holder writes nothing.
   */
  commit?: (tx: Tx) => Promise<void>
}

/** Handlers are idempotent: a retried or re-claimed work may run them again. */
export type WorkHandler = (context: WorkContext) => Promise<WorkSuccess | undefined>

/**
 * Says whether the area of a work is switched off (SPEC §8): the key of the switch that is
 * off, or `null` to run. A paused work waits with `paused_reason = 'switch_off:<key>'`.
 */
export type WorkGate = (work: WorkRow, db: Db) => Promise<string | null>

export interface WorkRunnerOptions {
  db: Db
  role: WorkRole
  /** Handlers of this role's kinds; only kinds with a handler are claimed. */
  handlers: Partial<Record<WorkKind, WorkHandler>>
  /**
   * Concurrency per slot of the role (`FETCH_JOBS`, `ENCODE_JOBS`, `COPY_JOBS`,
   * `IMAGE_JOBS`; `general` for the light kinds of `worker`, `hub` for Hub); default 1 per slot.
   */
  limits?: Partial<Record<WorkSlot, number>>
  /**
   * Limits that depend on the moment, asked before each claim (SPEC §12.0: photo batches
   * slow down while two AV1 encodes run); missing slots keep `limits`.
   */
  dynamicLimits?: (db: Db) => Promise<Partial<Record<WorkSlot, number>>>
  gate?: WorkGate
  /** Poll interval; the runner also polls right after a work finishes. Default 1 s. */
  pollMs?: number
  /** Lease length; default 60 s. */
  leaseMs?: number
  /** Lease renewal; default a third of the lease. */
  heartbeatMs?: number
  /** Attempts before a transient failure becomes final; default 5. */
  maxAttempts?: number | ((kind: WorkKind) => number)
  /** Pause before attempt n + 1 after n failed; default 5 s · 2^(n-1), at most 15 min. */
  backoffMs?: (attemptNo: number, kind: WorkKind) => number
  /** How long `stop()` waits for aborted handlers to settle; default 30 s. */
  stopTimeoutMs?: number
  /** Lease owner name; default `<role>:<host>:<pid>:<random>`. */
  owner?: string
  log?: (line: string, error?: unknown) => void
}

interface Running {
  work: WorkRow
  slot: WorkSlot
  controller: AbortController
  done: Promise<void>
  lost: boolean
}

const DEFAULT_BACKOFF = (attemptNo: number) => Math.min(5_000 * 2 ** (attemptNo - 1), 900_000)

/**
 * Background work executor of one role (SPEC §12.0 «Фоновые работы», schema §3.4, §9.2).
 * Claims due rows of its kinds with `FOR UPDATE SKIP LOCKED` by priority within the slot
 * limits, holds a lease with heartbeats and checks the fence generation on every write.
 */
export class WorkRunner {
  readonly role: WorkRole
  readonly owner: string
  private readonly db: Db
  private readonly handlers: Partial<Record<WorkKind, WorkHandler>>
  private readonly limits: Record<WorkSlot, number>
  private readonly dynamicLimits: WorkRunnerOptions['dynamicLimits']
  private readonly kindsBySlot: Map<WorkSlot, WorkKind[]>
  private readonly gate: WorkGate | undefined
  private readonly pollMs: number
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  private readonly maxAttempts: (kind: WorkKind) => number
  private readonly backoffMs: (attemptNo: number, kind: WorkKind) => number
  private readonly log: (line: string, error?: unknown) => void
  private readonly stopTimeoutMs: number
  private readonly running = new Map<string, Running>()
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<void> | undefined
  private again = false
  private stopping = false

  constructor(options: WorkRunnerOptions) {
    this.db = options.db
    this.role = options.role
    this.handlers = options.handlers
    this.gate = options.gate
    this.pollMs = options.pollMs ?? 1_000
    this.leaseMs = options.leaseMs ?? 60_000
    this.heartbeatMs = options.heartbeatMs ?? Math.floor(this.leaseMs / 3)
    const max = options.maxAttempts ?? 5
    this.maxAttempts = typeof max === 'number' ? () => max : max
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF
    this.owner =
      options.owner ?? `${options.role}:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
    this.log = options.log ?? (() => {})
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000

    const own = workKindsByRole[options.role] as readonly WorkKind[]
    this.kindsBySlot = new Map()
    for (const kind of Object.keys(options.handlers) as WorkKind[]) {
      if (!own.includes(kind)) {
        throw new Error(
          `${kind} belongs to ${workKindRole[kind] ?? 'no role'}, not ${options.role}`,
        )
      }
      const slot = workKindSlot[kind]
      this.kindsBySlot.set(slot, [...(this.kindsBySlot.get(slot) ?? []), kind])
    }
    this.limits = { general: 1, fetch: 1, encode: 1, copy: 1, image: 1, hub: 1, ...options.limits }
    this.dynamicLimits = options.dynamicLimits
  }

  /** Starts polling: every `pollMs` and right after a work finishes. */
  start(): void {
    if (this.timer || this.stopping) return
    this.timer = setInterval(() => this.poke(), this.pollMs)
    this.poke()
  }

  /**
   * Stops claiming, returns this runner's running rows to `retry_wait` without counting the
   * attempt, aborts their handlers and waits for them to settle.
   */
  async stop(): Promise<void> {
    this.stopping = true
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
    const running = [...this.running.values()]
    for (const job of running) job.controller.abort(new RunnerStoppedError())
    await Promise.all(running.map((job) => this.release(job, 'returned')))
    // The rows are back in the queue; a handler deaf to its signal cannot write any more.
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled(running.map((job) => job.done)),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, this.stopTimeoutMs)
      }),
    ])
    clearTimeout(timeout)
  }

  /** Claims and starts what is due now; resolves when the claim is done, not the works. */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true
      return this.ticking
    }
    this.ticking = this.claimAndStart().finally(() => {
      this.ticking = undefined
      if (this.again && !this.stopping) {
        this.again = false
        this.poke()
      }
    })
    return this.ticking
  }

  /** Works this runner holds right now. */
  get active(): number {
    return this.running.size
  }

  private poke(): void {
    if (this.stopping) return
    this.tick().catch((error: unknown) => this.log(`${this.role}: claim failed`, error))
  }

  private async claimAndStart(): Promise<void> {
    const now = this.dynamicLimits ? await this.dynamicLimits(this.db) : {}
    for (const [slot, kinds] of this.kindsBySlot) {
      if (this.stopping) return
      const busy = [...this.running.values()].filter((job) => job.slot === slot).length
      const free = (now[slot] ?? this.limits[slot]) - busy
      if (free <= 0) continue
      for (const work of await this.claim(kinds, free)) this.begin(work, slot)
    }
  }

  private async claim(kinds: WorkKind[], limit: number): Promise<WorkRow[]> {
    const { rows } = await this.db.execute(sql`
      WITH due AS (
        SELECT id FROM work_operations
         WHERE kind = ANY (${sql.param(kinds)}::text[])
           AND ((paused_reason IS NULL AND state IN ('pending', 'retry_wait')
                 AND next_attempt_at <= now())
                OR (state = 'running' AND lease_until < now()))
         ORDER BY priority DESC, next_attempt_at, id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE work_operations AS w
         SET state = 'running',
             lease_owner = ${this.owner},
             lease_until = now() + ${this.leaseMs}::bigint * interval '1 millisecond',
             heartbeat_at = now(),
             fence_generation = w.fence_generation + 1,
             attempt_no = w.attempt_no + 1,
             started_at = coalesce(w.started_at, now())
        FROM due
       WHERE w.id = due.id
      RETURNING w.*`)
    return rows.map(toWorkRow)
  }

  private begin(work: WorkRow, slot: WorkSlot): void {
    const controller = new AbortController()
    const job: Running = { work, slot, controller, lost: false, done: Promise.resolve() }
    this.running.set(work.id, job)
    job.done = this.execute(job).finally(() => {
      this.running.delete(work.id)
      this.poke()
    })
  }

  private async execute(job: Running): Promise<void> {
    const { work } = job
    const heartbeat = setInterval(() => {
      this.renew(job).catch((error: unknown) => this.log(`${this.role}: renew failed`, error))
    }, this.heartbeatMs)
    try {
      if (work.attemptNo > this.maxAttempts(work.kind)) {
        await this.finishFailure(job, 'transient', 'attempts_exhausted', 'attempts exhausted')
        return
      }
      const off = this.gate ? await this.gate(work, this.db) : null
      if (off) {
        await this.release(job, 'paused', off)
        return
      }
      const handler = this.handlers[work.kind]
      if (!handler) throw new Error(`no handler for ${work.kind}`)
      try {
        const result = await handler({
          work,
          signal: job.controller.signal,
          db: this.db,
          checkpoint: (update) => this.checkpoint(job, update),
        })
        if (job.lost || this.stopping) return
        // A failing `commit` rolls back with the finish and counts as a failed attempt.
        await this.finishSuccess(job, result ?? {})
      } catch (error) {
        if (job.lost || this.stopping) return
        if (error instanceof WorkDeferred) {
          await this.release(job, 'deferred', undefined, error)
          return
        }
        const failure =
          error instanceof WorkError
            ? error
            : new WorkError('transient', 'unexpected', errorText(error), { cause: error })
        await this.finishFailure(job, failure.kind, failure.code, failure.message, failure)
      }
    } catch (error) {
      this.log(`${this.role}: ${work.kind} ${work.workKey} broke the runner`, error)
      // Do not leave the row to the lease: give it back at once if the database answers.
      await this.release(job, 'returned').catch(() => {})
    } finally {
      clearInterval(heartbeat)
    }
  }

  /** Fenced write: only the holder of the current generation of a running row. */
  private fence(job: Running) {
    return sql`id = ${job.work.id} AND state = 'running' AND lease_owner = ${this.owner}
      AND fence_generation = ${job.work.fenceGeneration}`
  }

  private lose(job: Running): never {
    job.lost = true
    const error = new LeaseLostError(job.work.id)
    job.controller.abort(error)
    throw error
  }

  private async renew(job: Running): Promise<void> {
    if (job.lost) return
    const result = await this.db.execute(sql`
      UPDATE work_operations
         SET lease_until = now() + ${this.leaseMs}::bigint * interval '1 millisecond', heartbeat_at = now()
       WHERE ${this.fence(job)}`)
    if (result.rowCount === 0) {
      try {
        this.lose(job)
      } catch {
        this.log(`${this.role}: lost the lease of ${job.work.kind} ${job.work.workKey}`)
      }
    }
  }

  private async checkpoint(
    job: Running,
    update: Parameters<WorkContext['checkpoint']>[0],
  ): Promise<void> {
    if (job.lost) this.lose(job)
    const result = await this.db.execute(sql`
      UPDATE work_operations
         SET checkpoint = coalesce(${json(update.checkpoint)}::jsonb, checkpoint),
             progress_num = coalesce(${update.progress?.num ?? null}::bigint, progress_num),
             progress_den = coalesce(${update.progress?.den ?? null}::bigint, progress_den),
             progress_note = coalesce(${update.progress?.note ?? null}, progress_note),
             lease_until = now() + ${this.leaseMs}::bigint * interval '1 millisecond',
             heartbeat_at = now()
       WHERE ${this.fence(job)}`)
    if (result.rowCount === 0) this.lose(job)
  }

  private async finishSuccess(job: Running, result: WorkSuccess): Promise<void> {
    const written = await this.outcome(job, 'succeeded', async (tx) => {
      const locked = await tx.execute(
        sql`SELECT id FROM work_operations WHERE ${this.fence(job)} FOR UPDATE`,
      )
      if (locked.rows.length === 0) return false
      await result.commit?.(tx)
      await tx.execute(sql`
        UPDATE work_operations
           SET state = 'succeeded', finished_at = now(), lease_owner = NULL, lease_until = NULL,
               output_sha256 = ${result.outputSha256 ?? null}::bytea,
               output_ref = ${result.outputRef ?? null},
               report = ${json(result.report)}::jsonb,
               failure_kind = NULL, error_code = NULL, error_text = NULL
         WHERE id = ${job.work.id}`)
      return true
    })
    if (!written) job.lost = true
  }

  private async finishFailure(
    job: Running,
    kind: FailureKind,
    code: string,
    message: string,
    error?: WorkError,
  ): Promise<void> {
    const { work } = job
    const final = kind === 'permanent' || work.attemptNo >= this.maxAttempts(work.kind)
    const waitMs = Math.max(this.backoffMs(work.attemptNo, work.kind), error?.retryAfterMs ?? 0)
    await this.outcome(job, final ? 'failed' : 'retry', async (tx) => {
      const result = await tx.execute(sql`
        UPDATE work_operations
           SET state = ${final ? 'failed' : 'retry_wait'},
               finished_at = ${final ? sql`now()` : null},
               next_attempt_at = ${final ? sql`next_attempt_at` : sql`now() + ${waitMs}::bigint * interval '1 millisecond'`},
               lease_owner = NULL, lease_until = NULL,
               failure_kind = ${kind}, error_code = ${code}, error_text = ${message}
         WHERE ${this.fence(job)}`)
      return (result.rowCount ?? 0) > 0
    })
  }

  /**
   * Gives the row back without counting the attempt: on stop (`returned`), a switched-off
   * area (`paused`) or a wait for another work (`deferred`).
   */
  private async release(
    job: Running,
    outcome: 'returned' | 'paused' | 'deferred',
    key?: string,
    deferred?: WorkDeferred,
  ) {
    await this.outcome(job, outcome, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE work_operations
           SET state = 'retry_wait', attempt_no = attempt_no - 1,
               next_attempt_at = now() + ${deferred?.afterMs ?? 0}::bigint * interval '1 millisecond',
               progress_note = coalesce(${deferred?.note ?? null}, progress_note),
               lease_owner = NULL, lease_until = NULL,
               paused_reason = ${key ? `switch_off:${key}` : null}
         WHERE ${this.fence(job)}`)
      return (result.rowCount ?? 0) > 0
    })
  }

  /** Runs a fenced write with the typed `work.<outcome>` journal event in one transaction. */
  private async outcome(
    job: Running,
    outcome: 'succeeded' | 'retry' | 'failed' | 'returned' | 'paused' | 'deferred',
    write: (tx: Tx) => Promise<boolean>,
  ): Promise<boolean> {
    const { work } = job
    return withActorTx(
      this.db,
      {
        actor: SYSTEM_ACTOR(this.role),
        action: `work.${outcome}`,
        requestId: `work:${work.id}:${work.fenceGeneration}`,
        workId: work.id,
      },
      async (tx) => {
        if (!(await write(tx))) return false
        const { rows } = await tx.execute<{
          error_code: string | null
          paused_reason: string | null
        }>(sql`SELECT error_code, paused_reason FROM work_operations WHERE id = ${work.id}`)
        await logAction(tx, {
          modelId: work.modelId,
          subjectKind: 'work_operations',
          subjectId: work.id,
          subjectLabel: `${work.kind}:${work.workKey}`,
          after: {
            kind: work.kind,
            attempt:
              outcome === 'returned' || outcome === 'paused' || outcome === 'deferred'
                ? work.attemptNo - 1
                : work.attemptNo,
            generation: work.fenceGeneration,
            outcome,
            error_code:
              outcome === 'retry' || outcome === 'failed' ? rows[0]?.error_code : undefined,
            paused_reason: outcome === 'paused' ? rows[0]?.paused_reason : undefined,
            owner: this.owner,
          },
          result: outcome === 'failed' ? 'error' : 'ok',
        })
        return true
      },
    )
  }
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
