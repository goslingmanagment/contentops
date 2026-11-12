import type { ModelCounters, Queue, SystemState } from '@contentops/contracts/domain/system'
import { type Db, logAction, pausedQueues, setQueuePaused, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instant, requireActor } from '../commands'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { hubLatency } from '../hub/views'
import { inboxCount } from '../intake/inbox-view'
import { evaluateRow, loadState } from '../plan/state'
import { missedBefore, todayRows } from '../plan/views'
import type { Services } from '../services'
import { diskViews, readHostSpace, type SpaceOptions, spaceCard } from '../space'
import { openCustomCopies } from './inbox-alerts'

/**
 * «Настройки › Состояние» and the counters of the left column (DESIGN §2.2, §4.19; SPEC
 * §12.0 «Наблюдаемость»): queues of background work from `work_operations`, the owner's
 * «Пауза», space of the host disks, backup. Blocks of later stages stay empty.
 */

const QUEUE_LABEL: Record<values.WorkQueue, string> = {
  fetch: 'Забор с диска',
  preview: 'Превью',
  compress: 'Сжатие',
  frames: 'Кадры',
  copies: 'Копии для платформы',
}

const PAUSE_WORD = (paused: boolean) => (paused ? 'на паузе' : 'работает')

interface KindRow {
  kind: values.WorkKind
  unfinished: number
  /** Running works that report progress, and the sum of their fractions. */
  running: number
  done: number
}

/** Unfinished works per queue; progress — the mean of the running works that report it. */
async function queueViews(db: Db): Promise<Queue[]> {
  const { rows } = await db.execute<{
    kind: values.WorkKind
    unfinished: string
    running: string
    done: number | null
  }>(sql`
    SELECT kind,
           count(*) AS unfinished,
           count(*) FILTER (WHERE state = 'running' AND progress_den > 0) AS running,
           sum(least(1, progress_num::float8 / progress_den))
             FILTER (WHERE state = 'running' AND progress_den > 0) AS done
      FROM work_operations
     WHERE state IN ('pending', 'running', 'retry_wait')
     GROUP BY kind`)
  const kinds: KindRow[] = rows.map((row) => ({
    kind: row.kind,
    unfinished: Number(row.unfinished),
    running: Number(row.running),
    done: Number(row.done ?? 0),
  }))
  const paused = await pausedQueues(db)
  return values.workQueues.map((key) => {
    const own = kinds.filter((row) => values.workKindQueue[row.kind] === key)
    const running = own.reduce((sum, row) => sum + row.running, 0)
    const done = own.reduce((sum, row) => sum + row.done, 0)
    return {
      key,
      label: QUEUE_LABEL[key],
      pending: own.reduce((sum, row) => sum + row.unfinished, 0),
      progress: running > 0 ? done / running : null,
      paused: paused.has(key),
    }
  })
}

/** A copy of the database older than this is a warning (ecosystem plan 12.11.2026, item 5). */
const COPY_STALE_HOURS = 36

const REPOSITORY_WORD: Record<string, string> = { mac: 'на маке' }

/**
 * «Место и бэкап»: the newest copy of the database (the nightly copy to the owner's Mac reports
 * itself, `admin.reportBackup`) and the masters, which no copy covers yet (SPEC §12.3).
 */
async function backupState(db: Db): Promise<SystemState['backup']> {
  const { rows } = await db.execute<{
    dump_at: string | null
    full_at: string | null
    repository: string | null
    masters: string | null
  }>(sql`
    SELECT (SELECT max(db_snapshot_at)::text FROM backup_checkpoints
             WHERE state IN ('db_only', 'complete')) AS dump_at,
           (SELECT max(db_snapshot_at)::text FROM backup_checkpoints
             WHERE state = 'complete') AS full_at,
           (SELECT repository FROM backup_checkpoints WHERE state IN ('db_only', 'complete')
             ORDER BY db_snapshot_at DESC LIMIT 1) AS repository,
           (SELECT sum(byte_size)::text FROM blobs WHERE state = 'present') AS masters`)
  const row = rows[0]
  const full = row?.full_at ? instant(row.full_at) : null
  return {
    text: 'Копии базы нет',
    last_full_at: full,
    last_dump_at: row?.dump_at ? instant(row.dump_at) : null,
    dump_where: row?.repository ? (REPOSITORY_WORD[row.repository] ?? row.repository) : null,
    stale_after_hours: COPY_STALE_HOURS,
    // Until a full point exists, the bytes of the masters and uploads have no copy.
    uncovered_bytes: full ? null : Number(row?.masters ?? 0),
  }
}

async function systemState(db: Db, space: SpaceOptions): Promise<SystemState> {
  const [queues, report, latency, backup] = await Promise.all([
    queueViews(db),
    readHostSpace(space.file),
    hubLatency(db),
    backupState(db),
  ])
  return {
    queues,
    disks: diskViews(report, space, new Date()),
    backup,
    // Storage checks, AI and duplicates come with their stages.
    hub_latency: latency,
    storage_findings: [],
    ai_spend: null,
    cross_model_duplicates: null,
  }
}

/** Steps a person still has in the plan: a row in plan, missed, blocked, or a ◆ of Hub. */
const NEEDS_STEP: ReadonlySet<string> = new Set(['planned', 'missed', 'blocked_second_person'])

/**
 * Counters of the left column (DESIGN §2.2): «Приехало» — groups where a person is needed, the
 * number of the tab «Новое»; today's rows the person posts that still need a step (the owner
 * sees every page) and ▲ «пропущено» of the previous 7 days, red when one of them is missed. A
 * ◆ or ▲ in either, or an open «Копия кастома», puts the dot on the avatar of the model.
 */
async function modelCounters(db: Db, actor: Actor, code: string): Promise<ModelCounters> {
  const scope = await modelScopeOf(db, code)
  if (!scope || actor.role === 'reader') {
    return { model: code, inbox: 0, plan: 0, plan_missed: false, attention: false }
  }
  const state = await loadState(db, scope)
  const verdicts = todayRows(state)
    .filter((row) => actor.role === 'owner' || row.executor_id === actor.id)
    .map((row) => evaluateRow(state, row))
  const steps = verdicts.filter(
    (verdict) => NEEDS_STEP.has(verdict.level) || verdict.sign === 'turn',
  )
  const earlier = missedBefore(state, actor.role === 'owner' ? null : actor.id)
  const inbox = await inboxCount(db, scope.id)
  // «Копии кастомов» (SPEC §6.2): a custom outside its section is a ▲ of the model too.
  const copies = await openCustomCopies(db, scope.id)
  return {
    model: code,
    inbox: inbox.count,
    plan: steps.length + earlier.length,
    plan_missed: earlier.length > 0 || steps.some((verdict) => verdict.level === 'missed'),
    attention:
      inbox.attention ||
      copies > 0 ||
      verdicts.some((verdict) => verdict.sign === 'turn' || verdict.sign === 'trouble'),
  }
}

async function modelScopeOf(db: Db, code: string): Promise<ModelScope | undefined> {
  const { rows } = await db.execute<ModelScope & Record<string, unknown>>(sql`
    SELECT id, code, title AS name FROM models WHERE code = ${code} AND archived_at IS NULL`)
  return rows[0]
}

export function systemHandlers({ db, command, space }: Services): HandlerRegistry {
  return {
    admin: {
      state: () => systemState(db, space),
      // The copy to the owner's Mac reports itself after its checks (an agent token, staff).
      reportBackup: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            INSERT INTO backup_checkpoints (db_snapshot_at, dump_key, dump_sha256, dump_bytes,
                                            state, repository, reported_by)
            VALUES (${body.db_snapshot_at}::timestamptz, ${body.dump_key},
                    ${body.dump_sha256 ?? null}, ${body.dump_bytes ?? null}, 'db_only',
                    ${body.repository}, ${actor.id}::uuid)
            ON CONFLICT ON CONSTRAINT backup_checkpoints_dump DO NOTHING
            RETURNING id`)
          if (rows[0]) {
            await logAction(tx, {
              modelId: null,
              subjectKind: 'backup_checkpoints',
              subjectId: rows[0].id,
              subjectLabel: 'Копия базы',
              after: {
                Где: REPOSITORY_WORD[body.repository] ?? body.repository,
                Снимок: body.db_snapshot_at,
              },
            })
          }
          return { ok: true as const }
        }),
      counters: async ({ ctx }) => {
        const actor = requireActor(ctx)
        const report = await readHostSpace(space.file)
        const models = []
        for (const model of actor.models) models.push(await modelCounters(db, actor, model))
        return {
          models,
          space: spaceCard(diskViews(report, space, new Date())),
          generated_at: new Date().toISOString(),
        }
      },
    },
    settings: {
      // Owner only (access.ts: `/admin/…`); the workers check the switch before every attempt.
      pauseQueue: async ({ params, body, ctx }) => {
        const queue = values.workQueues.find((key) => key === params.queue)
        if (!queue) throw new ApiProblem('not_found', 'Такой очереди нет')
        await command({ ctx, body }, async (tx, actor) => {
          const was = (await pausedQueues(tx)).has(queue)
          await setQueuePaused(tx, queue, body.paused, actor.id)
          await logAction(tx, {
            modelId: null,
            subjectKind: 'queue',
            subjectLabel: QUEUE_LABEL[queue],
            before: { Очередь: PAUSE_WORD(was) },
            after: { Очередь: PAUSE_WORD(body.paused) },
          })
        })
        return systemState(db, space)
      },
    },
  }
}
