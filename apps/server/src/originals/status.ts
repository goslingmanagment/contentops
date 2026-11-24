import type { Queryable } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { type Holder, originalStates } from './rule'

/**
 * `ops.js originals status` (SPEC §9.4): counts of the rule per model — originals, reliable,
 * decided, releasable — by where they lie on the PC (the copy of Я.Диск, the Dropbox files,
 * web uploads on our disk), why the rest is not decided, and the rows of the ledger by cloud.
 * Counts only: no paths, no names.
 */

interface Tally {
  originals: number
  bytes: number
  reliable: number
  decided: number
  releasable: number
  releasable_bytes: number
}

export interface OriginalsStatus {
  model: string
  totals: Tally
  /** By where the original lies on the PC. */
  holders: Partial<Record<Holder, Tally>>
  /** Why the rest is not decided, counted. */
  undecided: Record<string, number>
  /**
   * The ledger by cloud: rows, checked, missing, checked bytes; `dropbox_copy` — ContentOps's own
   * copies in the model's Dropbox, apart from its files there.
   */
  places: Record<string, { rows: number; checked: number; missing: number; checked_bytes: number }>
}

const empty = (): Tally => ({
  originals: 0,
  bytes: 0,
  reliable: 0,
  decided: 0,
  releasable: 0,
  releasable_bytes: 0,
})

function add(tally: Tally, bytes: number, reliable: boolean, decided: boolean, release: boolean) {
  tally.originals += 1
  tally.bytes += bytes
  if (reliable) tally.reliable += 1
  if (decided) tally.decided += 1
  if (release) {
    tally.releasable += 1
    tally.releasable_bytes += bytes
  }
}

export async function originalsStatus(q: Queryable, model?: string): Promise<OriginalsStatus[]> {
  const { rows: models } = await q.execute<{ id: string; code: string }>(sql`
    SELECT id, code FROM models
     WHERE (${model ?? null}::text IS NULL OR code = ${model ?? null}::text)
       AND (${model ?? null}::text IS NOT NULL OR archived_at IS NULL)
     ORDER BY code`)
  if (model && models.length === 0) throw new Error(`${model}: no such model`)
  const out: OriginalsStatus[] = []
  for (const { id, code } of models) {
    const totals = empty()
    const holders: OriginalsStatus['holders'] = {}
    const undecided: Record<string, number> = {}
    for (const state of await originalStates(q, id)) {
      // A web upload already released holds nothing on the PC.
      if (state.released) continue
      const bytes = Number(state.byte_size)
      const holder = holders[state.holder] ?? empty()
      holders[state.holder] = holder
      add(totals, bytes, state.reliable, state.decided, state.releasable)
      add(holder, bytes, state.reliable, state.decided, state.releasable)
      if (!state.decided) undecided[state.reason] = (undecided[state.reason] ?? 0) + 1
    }
    const { rows: places } = await q.execute<{
      place: string
      rows: string
      checked: string
      missing: string
      checked_bytes: string
    }>(sql`
      SELECT CASE WHEN role = 'copy' AND place <> 'mega' THEN place || '_copy' ELSE place END
               AS place,
             count(*)::text AS rows,
             count(*) FILTER (WHERE verified_at IS NOT NULL AND missing_since IS NULL)::text
               AS checked,
             count(missing_since)::text AS missing,
             COALESCE(sum(byte_size) FILTER (WHERE verified_at IS NOT NULL
                                               AND missing_since IS NULL), 0)::text
               AS checked_bytes
        FROM original_copies WHERE model_id = ${id}::uuid
       GROUP BY 1 ORDER BY 1`)
    out.push({
      model: code,
      totals,
      holders,
      undecided,
      places: Object.fromEntries(
        places.map((row) => [
          row.place,
          {
            rows: Number(row.rows),
            checked: Number(row.checked),
            missing: Number(row.missing),
            checked_bytes: Number(row.checked_bytes),
          },
        ]),
      ),
    })
  }
  return out
}
