import type { NewPlanRow } from '@contentops/contracts/commands/plan'
import { notFound, rule } from '../domain-error'
import { accountOf } from '../fixtures/facts'
import { copyBytes } from '../fixtures/plan-builder'
import type { ModelWorld, PlacementTrack, PlanRowRecord } from '../fixtures/world-types'
import type { MockState } from '../state'

/** Creating and finding plan rows for every handler that puts something into the plan. */

function nextRowId(model: ModelWorld): string {
  let number = model.plan_rows.size + 1
  let id = `r-${model.model.code}-new-${number}`
  while (model.plan_rows.has(id)) {
    number += 1
    id = `r-${model.model.code}-new-${number}`
  }
  return id
}

/** Validates a row against the one hard rule: second person in frame never goes to OnlyFans. */
export function rowProblem(
  model: ModelWorld,
  input: NewPlanRow,
): { code: string; text: string } | null {
  const account = model.model.accounts.find((candidate) => candidate.code === input.account)
  if (!account) return { code: 'not_found', text: `Страницы ${input.account} нет` }
  if (!input.item_id)
    return input.awaiting_montage ? null : { code: 'invalid_request', text: 'Не выбран объект' }
  const record = model.items.get(input.item_id)
  if (record?.lifecycle.state !== 'active') {
    return { code: 'not_found', text: `${input.item_id} нет` }
  }
  if (record.entry.second_person && account.platform === 'onlyfans') {
    return { code: 'second_person_onlyfans', text: 'нельзя: второй человек в кадре' }
  }
  return null
}

/** Platform copy size of the object on this place — the same measure as the fixtures. */
function copySize(model: ModelWorld, itemId: string, surface: NewPlanRow['surface']): number {
  const entry = model.items.get(itemId)?.entry
  return entry ? copyBytes(entry, surface) : 0
}

export function buildRow(
  state: MockState,
  model: ModelWorld,
  input: NewPlanRow,
  releaseId: string | null = null,
): PlanRowRecord {
  const account = accountOf(model, input.account)
  const now = state.clock.now()
  return {
    id: nextRowId(model),
    date: input.date,
    time: input.time,
    account: input.account,
    surface: input.surface,
    item_id: input.item_id,
    fyp_version: input.fyp_version,
    assignee: input.assignee ?? account.usual_assignee,
    mark: input.marked
      ? {
          kind: input.marked,
          at: now,
          by: state.principal.id,
          stated_occurred_at: null,
          for_current_manifest: true,
        }
      : null,
    cancelled: null,
    release_id: releaseId,
    requires_new_upload: input.requires_new_upload,
    has_newer_version: false,
    second_person_blocked: false,
    note: input.note,
    album: null,
    copy: input.item_id
      ? { state: 'ready', size_bytes: copySize(model, input.item_id, input.surface) }
      : null,
    downloaded: null,
    awaiting_montage: input.awaiting_montage,
    created_by: state.principal.id,
    created_at: now,
    version: 1,
  }
}

export function insertRow(model: ModelWorld, row: PlanRowRecord): PlanRowRecord {
  model.plan_rows.set(row.id, row)
  model.summary_version += 1
  return row
}

export function rowOf(model: ModelWorld, id: string): PlanRowRecord {
  const row = model.plan_rows.get(id)
  if (!row) throw notFound('Такой строки плана нет')
  return row
}

/** The track of a row, created on first evidence («Отметить и подтвердить»). */
export function trackForRow(model: ModelWorld, row: PlanRowRecord): PlacementTrack {
  const existing = model.tracks.find((track) => track.plan_row_id === row.id)
  if (existing) return existing
  const track: PlacementTrack = {
    id: `t-${row.id}`,
    item_id: row.item_id,
    account: row.account,
    surface: row.surface,
    plan_row_id: row.id,
    evidence: [],
    album: row.album,
    caption: null,
    stats: null,
    extras: null,
  }
  model.tracks.push(track)
  return track
}

export function assertOpen(row: PlanRowRecord) {
  if (row.cancelled) throw rule('row_cancelled', 'Не выполнено: строка отменена')
}
