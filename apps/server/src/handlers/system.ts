import type { ModelCounters, Queue, SystemState } from '@contentops/contracts/domain/system'
import { type Db, logAction, pausedQueues, setQueuePaused, values } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { requireActor } from '../commands'
import type { Actor, ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { evaluateRow, loadState } from '../plan/state'
import { todayRows } from '../plan/views'
import type { Services } from '../services'
import { diskViews, readHostSpace, type SpaceOptions, spaceCard } from '../space'

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

async function systemState(db: Db, space: SpaceOptions): Promise<SystemState> {
  const [queues, report] = await Promise.all([queueViews(db), readHostSpace(space.file)])
  return {
    queues,
    disks: diskViews(report, space, new Date()),
    // No backup on the pilot (SPEC §12.3, decision 12.09.2026).
    backup: { text: 'Бэкапа нет (пилот)', last_full_at: null, last_dump_at: null },
    // Hub is read from stage 5; storage checks, AI and duplicates come with their stages.
    hub_latency: null,
    storage_findings: [],
    ai_spend: null,
    cross_model_duplicates: null,
  }
}

/** Steps a person still has in the plan: a row in plan, missed, blocked, or a ◆ of Hub. */
const NEEDS_STEP: ReadonlySet<string> = new Set(['planned', 'missed', 'blocked_second_person'])

/**
 * Counters of the left column (DESIGN §2.2): today's rows the person posts that still need a
 * step (the owner sees every page), whether one of them is missed; «Приехало» counts with 2в.
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
  return {
    model: code,
    inbox: 0,
    plan: steps.length,
    plan_missed: steps.some((verdict) => verdict.level === 'missed'),
    attention: verdicts.some((verdict) => verdict.sign === 'turn' || verdict.sign === 'trouble'),
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
