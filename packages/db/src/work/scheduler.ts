import { sql } from 'drizzle-orm'
import type { Db } from '../client.ts'
import type { WorkKind } from '../values.ts'

/** A periodic work: Hub poll of a page, Yandex Disk scan of a source, backup. */
export interface PeriodicStream {
  /** `hub:<account>:<dataset>`, `scan:<source>`, `backup`. */
  streamKey: string
  kind: WorkKind
  /** `null` only for system-wide kinds. */
  modelId: string | null
  intervalMs: number
  priority?: number
  accountId?: string | null
  dataset?: string | null
  scope?: string | null
  /** Put the interval bounds into `window_from` / `window_to` (Hub polls). */
  windowed?: boolean
}

export interface WorkSchedulerOptions {
  db: Db
  /** Streams to keep; read on every tick, so switches and new pages apply at once. */
  streams: () => PeriodicStream[] | Promise<PeriodicStream[]>
  /** Default 1 s. */
  pollMs?: number
  log?: (line: string, error?: unknown) => void
}

/**
 * Periodic scheduler inside role `worker` (SPEC §12.0): one row per interval per stream.
 * The interval start (from the database clock) is part of `work_key`, so two schedulers
 * insert one row; the partial unique index on `stream_key` keeps at most one unfinished
 * row per stream, so a busy stream skips the interval instead of piling up.
 */
export class WorkScheduler {
  private readonly db: Db
  private readonly streams: WorkSchedulerOptions['streams']
  private readonly pollMs: number
  private readonly log: (line: string, error?: unknown) => void
  private timer: NodeJS.Timeout | undefined
  private ticking: Promise<number> | undefined

  constructor(options: WorkSchedulerOptions) {
    this.db = options.db
    this.streams = options.streams
    this.pollMs = options.pollMs ?? 1_000
    this.log = options.log ?? (() => {})
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.log('scheduler: tick failed', error))
    }, this.pollMs)
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    await this.ticking?.catch(() => {})
  }

  /** Inserts the current interval's row of every stream that has none; returns how many. */
  async tick(): Promise<number> {
    if (this.ticking) return this.ticking
    this.ticking = this.schedule().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async schedule(): Promise<number> {
    let created = 0
    for (const stream of await this.streams()) {
      const { rowCount } = await this.db.execute(sql`
        WITH slot AS (
          SELECT to_timestamp(floor(extract(epoch FROM now()) * 1000 / ${stream.intervalMs}::bigint)
                              * ${stream.intervalMs}::bigint / 1000.0) AS starts
        )
        INSERT INTO work_operations (
          model_id, kind, work_key, priority, account_id, dataset, scope,
          window_from, window_to, stream_key
        )
        SELECT ${stream.modelId}::uuid, ${stream.kind},
               ${stream.streamKey} || '@' || to_char(starts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               ${stream.priority ?? 0}, ${stream.accountId ?? null}::uuid,
               ${stream.dataset ?? null}, ${stream.scope ?? null},
               CASE WHEN ${stream.windowed ?? false} THEN starts END,
               CASE WHEN ${stream.windowed ?? false}
                    THEN starts + ${stream.intervalMs}::bigint * interval '1 millisecond' END,
               ${stream.streamKey}
          FROM slot
        ON CONFLICT DO NOTHING`)
      created += rowCount ?? 0
    }
    return created
  }
}
