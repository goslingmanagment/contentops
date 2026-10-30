import {
  type Db,
  enqueueWork,
  isSwitchOn,
  type Queryable,
  SYSTEM_ACTOR,
  type Tx,
  WorkError,
  type WorkHandler,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { historyPass } from './history'
import { type Page, pageOf } from './load'
import { type MatchReport, matchPage } from './match'
import { matchSettings } from './settings'

/**
 * When matching runs (SPEC §7, §8): after every `hub_sync` of a page while «Автосверка» of the
 * page is on, and the history pass of a Fansly page once when «Автосверка» is first switched on
 * (work `hub_history`, `history:<page>:first`) and again on the owner's command after a batch of
 * the library. The first history work also marks the start of matching: posts from then on
 * without plan are «пост без плана», older ones belong to the history.
 */

const FIRST = (accountId: string) => `history:${accountId}:first`

/** The start of matching of a page; `null` — «Автосверка» was never on. */
export async function liveFromOf(q: Queryable, page: Pick<Page, 'modelId' | 'accountId'>) {
  const { rows } = await q.execute<{ at: string | null }>(sql`
    SELECT window_to::text AS at FROM work_operations
     WHERE model_id = ${page.modelId}::uuid AND kind = 'hub_history'
       AND work_key = ${FIRST(page.accountId)}`)
  const at = rows[0]?.at
  return at ? new Date(at).toISOString() : null
}

/** Queues the first history pass of a page: once, the moment «Автосверка» first goes on. */
export async function startMatching(
  tx: Tx,
  page: Pick<Page, 'modelId' | 'accountId'>,
): Promise<string> {
  const { work } = await enqueueWork(tx, {
    modelId: page.modelId,
    kind: 'hub_history',
    workKey: FIRST(page.accountId),
    accountId: page.accountId,
    dataset: 'history',
    windowTo: new Date().toISOString(),
    priority: 4,
  })
  return work.windowTo ? new Date(work.windowTo).toISOString() : new Date().toISOString()
}

/** The pass again after a batch of the library (stages 7, 9a and «Старый формат» 9b). */
export async function enqueueHistory(
  tx: Tx,
  page: Pick<Page, 'modelId' | 'accountId'>,
  reason: string,
): Promise<{ id: string; created: boolean }> {
  const liveFrom = await liveFromOf(tx, page)
  const { work, created } = await enqueueWork(tx, {
    modelId: page.modelId,
    kind: 'hub_history',
    workKey: `history:${page.accountId}:${reason}`,
    accountId: page.accountId,
    dataset: 'history',
    windowTo: liveFrom ?? new Date().toISOString(),
    priority: 4,
  })
  return { id: work.id, created }
}

/**
 * The owner's command after a batch of the library: a history pass of every Fansly page of the
 * model (or one page) with «Автосверка» on; a page where it is off is skipped and said so.
 */
export async function enqueueHistoryPass(
  db: Db,
  input: { model: string; account: string | null },
): Promise<{ page: string; work_id: string | null; skipped: string | null }[]> {
  const { rows } = await db.execute<{
    model_id: string
    id: string
    code: string
    platform: string
  }>(sql`
    SELECT a.model_id, a.id, a.code, a.platform FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE m.code = ${input.model} AND a.archived_at IS NULL
       AND (${input.account}::text IS NULL OR a.code = ${input.account})
     ORDER BY a.position, a.id`)
  if (rows.length === 0) throw new Error(`no page ${input.account ?? ''} of model ${input.model}`)
  const reason = `batch-${new Date().toISOString()}`
  const out: { page: string; work_id: string | null; skipped: string | null }[] = []
  for (const page of rows) {
    const scope = { modelId: page.model_id, accountId: page.id }
    if (page.platform !== 'fansly') {
      out.push({ page: page.code, work_id: null, skipped: 'OnlyFans: прохода по истории нет' })
      continue
    }
    if (!(await isSwitchOn(db, 'hub.auto_match', scope))) {
      out.push({ page: page.code, work_id: null, skipped: 'Автосверка выключена' })
      continue
    }
    const queued = await withActorTx(
      db,
      {
        actor: SYSTEM_ACTOR('ops'),
        action: 'hub.history.enqueue',
        requestId: `${reason}:${page.id}`,
      },
      (tx) => enqueueHistory(tx, scope, reason),
    )
    out.push({ page: page.code, work_id: queued.id, skipped: null })
  }
  return out
}

export interface AutoMatchOptions {
  now?: Date
  workId?: string | null
  requestId: string
}

/** Matching of the page in its own transaction; `null` — «Автосверка» is off for the page. */
export async function autoMatch(
  db: Db,
  accountId: string,
  options: AutoMatchOptions,
): Promise<MatchReport | null> {
  const page = await pageOf(db, accountId)
  if (!page) return null
  if (!(await isSwitchOn(db, 'hub.auto_match', { modelId: page.modelId, accountId }))) return null
  return withActorTx(
    db,
    {
      actor: SYSTEM_ACTOR('hub'),
      action: 'hub.match',
      requestId: options.requestId,
      ...(options.workId ? { workId: options.workId } : {}),
    },
    async (tx) => {
      const liveFrom = (await liveFromOf(tx, page)) ?? (await startMatching(tx, page))
      const settings = await matchSettings(tx, page)
      return matchPage(tx, page, { now: options.now ?? new Date(), settings, liveFrom })
    },
  )
}

/** Work `hub_history` of role `worker`: the history pass of one page. */
export function hubHistoryHandler(): WorkHandler {
  return async ({ work, db }) => {
    if (!work.accountId) throw new WorkError('permanent', 'bad_stream', 'у работы нет страницы')
    const page = await pageOf(db, work.accountId)
    if (!page) throw new WorkError('permanent', 'bad_stream', 'страницы нет')
    if (page.platform !== 'fansly') {
      return { report: { skipped: 'На OnlyFans прохода по истории нет (SPEC §7)' } }
    }
    if (
      !(await isSwitchOn(db, 'hub.auto_match', {
        modelId: page.modelId,
        accountId: page.accountId,
      }))
    ) {
      return { report: { skipped: 'Автосверка выключена' } }
    }
    const liveFrom = work.windowTo
      ? new Date(work.windowTo).toISOString()
      : new Date().toISOString()
    const report = await withActorTx(
      db,
      {
        actor: SYSTEM_ACTOR('hub'),
        action: 'hub.history',
        requestId: `work:${work.id}:${work.fenceGeneration}`,
        workId: work.id,
      },
      async (tx) => historyPass(tx, page, { liveFrom, settings: await matchSettings(tx, page) }),
    )
    return { report: { ...report, live_from: liveFrom } }
  }
}
