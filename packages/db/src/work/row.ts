import type { workOperations } from '../../drizzle/schema.ts'
import type { FailureKind, WorkKind, WorkState } from '../values.ts'

/** A `work_operations` row as the executor and handlers see it. */
export type WorkRow = Omit<typeof workOperations.$inferSelect, 'kind' | 'state' | 'failureKind'> & {
  kind: WorkKind
  state: WorkState
  failureKind: FailureKind | null
}

const NUMERIC = new Set(['fenceGeneration', 'progressNum', 'progressDen'])

/** Maps a raw `RETURNING *` row (snake_case, int8 as text) to `WorkRow`. */
export function toWorkRow(raw: Record<string, unknown>): WorkRow {
  const row: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    row[camel] = NUMERIC.has(camel) && value !== null ? Number(value) : value
  }
  return row as WorkRow
}
