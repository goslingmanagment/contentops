import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase } from './testing/index.ts'
import * as v from './values.ts'

/**
 * Every literal list in a CHECK or an index predicate, by constraint or index name.
 * A new list in a migration must be registered here against its array in `values.ts`.
 */
const LISTS: Record<string, readonly string[]> = {
  models_code_reserved: v.reservedModelCodes,
  principals_kind_check: v.principalKinds,
  principals_gender_check: v.genders,
  principals_role_check: v.principalRoles,
  principals_ui_skin_check: v.uiSkins,
  accounts_platform_check: v.platforms,
  accounts_default_uniq_level_check: v.uniqLevels,
  surfaces_kind_check: v.surfaceKinds,
  surfaces_auto_match_kind: v.autoMatchSurfaceKinds,
  work_operations_kind_check: v.workKinds,
  work_operations_state_check: v.workStates,
  work_operations_failure_kind_check: v.failureKinds,
  work_operations_global_kinds: v.globalWorkKinds,
  work_operations_finished_at: v.finishedWorkStates,
  work_operations_stream_key: v.unfinishedWorkStates,
  work_operations_due: v.claimableWorkStates,
  id_counters_type_check: v.contentTypes,
  policy_settings_item_type_check: v.contentTypes,
  idempotency_keys_state_check: v.idempotencyStates,
  action_log_actor_type_check: v.actorTypes,
  action_log_entry_kind_check: v.logEntryKinds,
  action_log_result_check: v.logResults,
}

let pool: pg.Pool

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: (await createTestDatabase()).url() })
})
afterAll(() => pool.end())

function literalLists(definition: string): string[][] {
  return [...definition.matchAll(/ARRAY\[([^\]]*)\]/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/'((?:[^']|'')*)'::text/g)].map((m) =>
      (m[1] ?? '').replaceAll("''", "'"),
    ),
  )
}

describe('value lists', () => {
  it('every CHECK and predicate list equals its list in values.ts', async () => {
    const { rows } = await pool.query<{ name: string; definition: string }>(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE contype = 'c' AND connamespace = 'public'::regnamespace
      UNION ALL
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`)
    const found = new Map<string, string[]>()
    for (const row of rows) {
      const lists = literalLists(row.definition)
      if (lists.length === 0) continue
      expect(lists, `${row.name} holds more than one list`).toHaveLength(1)
      found.set(row.name, lists[0] ?? [])
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(LISTS).sort())
    for (const [name, list] of found) {
      expect(new Set(list), name).toEqual(new Set(LISTS[name]))
      expect(list, `${name} repeats a value`).toHaveLength(new Set(list).size)
    }
  })

  it('every kind of work belongs to exactly one role and one slot', () => {
    const kinds = v.workRoles.flatMap((role) => v.workKindsByRole[role])
    expect(new Set(kinds).size).toBe(kinds.length)
    expect(Object.keys(v.workKindRole).sort()).toEqual([...kinds].sort())
    expect(Object.keys(v.workKindSlot).sort()).toEqual([...kinds].sort())
    for (const kind of v.globalWorkKinds) expect(v.workKindRole[kind]).toBe('worker')
  })

  it('knows the kill switches of SPEC §8 and the thresholds', () => {
    for (const key of ['hub.receive', 'agents.token.0193', 'annotation.texts', 'ydisk.scan']) {
      expect(v.isKillSwitchKey(key), key).toBe(true)
    }
    expect(v.isKillSwitchKey('agents.token.')).toBe(false)
    expect(v.isPolicyKey('too_early_days')).toBe(true)
    expect(v.isPolicyKey('hub.unknown')).toBe(false)
  })
})
