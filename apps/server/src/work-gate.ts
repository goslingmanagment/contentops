import {
  type Db,
  isSwitchOn,
  pausedQueues,
  values,
  type WorkGate,
  type WorkRow,
} from '@contentops/db'
import { sql } from 'drizzle-orm'

/**
 * The kind of the cloud source a `scan` or `fetch` works with: a scan names its source in
 * `scope`, a fetch reaches it through its revision.
 */
async function sourceKindOf(work: WorkRow, db: Db): Promise<values.CloudSourceKind | null> {
  if (work.kind === 'scan' && work.scope) {
    const { rows } = await db.execute<{ kind: values.CloudSourceKind }>(sql`
      SELECT kind FROM sources WHERE id::text = ${work.scope}`)
    return rows[0]?.kind ?? null
  }
  if (work.kind === 'fetch' && work.sourceRevisionId) {
    const { rows } = await db.execute<{ kind: values.CloudSourceKind }>(sql`
      SELECT s.kind FROM source_revisions r
        JOIN source_objects o ON o.model_id = r.model_id AND o.id = r.source_object_id
        JOIN sources s ON s.model_id = o.model_id AND s.id = o.source_id
       WHERE r.model_id = ${work.modelId}::uuid AND r.id = ${work.sourceRevisionId}::uuid`)
    return rows[0]?.kind ?? null
  }
  return null
}

/**
 * Checked by the executor before every attempt (SPEC §8): the kill switch of the kind's
 * area (Hub, the scan of a source) and the owner's «Пауза» of its queue. A work held here
 * waits with `paused_reason = 'switch_off:<key>'` and its attempt is not counted; turning
 * the switch back on releases it (`resumeSwitch`).
 */
export function createWorkGate(): WorkGate {
  return async (work, db) => {
    const queue = values.workKindQueue[work.kind]
    if (queue && (await pausedQueues(db)).has(queue)) return values.queueSwitchKey(queue)
    const scope = { modelId: work.modelId, accountId: work.accountId }
    if (work.kind === 'scan' || work.kind === 'fetch') {
      const kind = await sourceKindOf(work, db)
      // A web upload or a local copy has no cloud switch.
      if (!kind) return null
      const key = values.sourceScanSwitch[kind]
      return (await isSwitchOn(db, key, scope)) ? null : key
    }
    const key = values.workKindSwitch[work.kind]
    if (key && !(await isSwitchOn(db, key, scope))) return key
    return null
  }
}
