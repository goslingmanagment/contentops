import { isSwitchOn, pausedQueues, values, type WorkGate } from '@contentops/db'

/**
 * Checked by the executor before every attempt (SPEC §8): the kill switch of the kind's
 * area (Hub, source scan) and the owner's «Пауза» of its queue. A work held here waits with
 * `paused_reason = 'switch_off:<key>'` and its attempt is not counted; turning the switch
 * back on releases it (`resumeSwitch`).
 */
export function createWorkGate(): WorkGate {
  return async (work, db) => {
    const queue = values.workKindQueue[work.kind]
    if (queue && (await pausedQueues(db)).has(queue)) return values.queueSwitchKey(queue)
    const key = values.workKindSwitch[work.kind]
    if (key && !(await isSwitchOn(db, key, { modelId: work.modelId, accountId: work.accountId }))) {
      return key
    }
    return null
  }
}
