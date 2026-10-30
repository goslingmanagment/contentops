import { apiRoutes } from '@contentops/contracts'
import { buildPath } from '@contentops/contracts/api/route'
import type { Clock } from '@contentops/contracts/clock'
import type { Instant, ModelCode } from '@contentops/contracts/domain/common'
import type { Operation, OperationKind } from '@contentops/contracts/domain/operations'

/** Long operations of the mock: progress follows real time, the result lands once. */

interface OperationRecord {
  id: string
  model: ModelCode | null
  kind: OperationKind
  label: string
  done_label: string
  created_at: Instant
  started_ms: number
  duration_ms: number
  result: Operation['result']
  on_done: OnDone | null
  finished_at: Instant | null
}

/**
 * Applied once when the operation finishes: the handoff becomes «подготовлено». What it
 * returns replaces the result — a number is issued only when the work is accepted.
 */
type OnDone = () => Operation['result'] | undefined

export interface StartOperation {
  model: ModelCode | null
  kind: OperationKind
  /** While running: «Архив дня собирается · Fansly 1». */
  label: string
  /** Once done: «Архив дня готов · Fansly 1» — the word changes, the size is in `result`. */
  done_label: string
  result: Operation['result']
  on_done?: OnDone
  duration_ms?: number
}

export interface OperationStore {
  start(input: StartOperation): { id: string; status_url: string }
  view(id: string): Operation | null
}

export function createOperationStore(clock: Clock, defaultDurationMs: number): OperationStore {
  const records = new Map<string, OperationRecord>()
  let counter = 0

  const statusUrl = (record: OperationRecord) =>
    record.model
      ? buildPath(apiRoutes.operations.get.path, { model: record.model, operation: record.id })
      : buildPath(apiRoutes.admin.operation.path, { operation: record.id })

  return {
    start(input) {
      counter += 1
      const record: OperationRecord = {
        id: `op-${counter}`,
        model: input.model,
        kind: input.kind,
        label: input.label,
        done_label: input.done_label,
        created_at: clock.now(),
        started_ms: Date.now(),
        duration_ms: input.duration_ms ?? defaultDurationMs,
        result: input.result,
        on_done: input.on_done ?? null,
        finished_at: null,
      }
      records.set(record.id, record)
      return { id: record.id, status_url: statusUrl(record) }
    },
    view(id) {
      const record = records.get(id)
      if (!record) return null
      const elapsed = Date.now() - record.started_ms
      const progress = record.duration_ms <= 0 ? 1 : Math.min(1, elapsed / record.duration_ms)
      if (progress >= 1 && record.finished_at === null) {
        record.finished_at = clock.now()
        record.result = record.on_done?.() ?? record.result
      }
      const done = record.finished_at !== null
      return {
        id: record.id,
        kind: record.kind,
        label: done ? record.done_label : record.label,
        state: done ? 'done' : 'running',
        progress: Math.round(progress * 100) / 100,
        created_at: record.created_at,
        finished_at: record.finished_at,
        result: done ? record.result : null,
        error: null,
      }
    },
  }
}
