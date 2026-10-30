import { adminRoutes } from '@contentops/contracts/api/routes/admin'
import type { ModelCode } from '@contentops/contracts/domain/common'
import { ITEM_TYPE_INFO, ItemTypeSchema } from '@contentops/contracts/domain/item-type'
import type { Threshold, ThresholdScope } from '@contentops/contracts/domain/system'
import { DomainError, notFound } from '../../domain-error'
import { type BoundRoute, bind } from '../../handler'
import type { MockState } from '../../state'
import { wholeList } from '../../views/paginate'
import { actorSays } from '../actor-says'
import { logSettingsChange } from './settings-log'
import { checkVersion } from './versions'

/**
 * «Пороги» (DESIGN §4.19): строка для всего и исключения для модели, страницы или типа.
 * Исключение заводится первым сохранением без `If-Match`, дальше меняется по версии.
 */

/** With `?demo=conflict` the owner's other device set these values first. */
const RIVAL_THRESHOLD: Record<Threshold['key'], number | null> = {
  too_early_days: 21,
  time_tolerance_min: 45,
  duration_tolerance_ms: 300,
  wait_hub_hours: 12,
  not_published_hours: 24,
  album_walk_reminder_days: 14,
  frame_similarity: 90,
  auto_accept: null,
}

/** Where a row applies: «Fansly 2», «для страницы Fansly 2» and the journals that get it. */
interface ScopeTarget {
  label: string | null
  /** « для страницы Fansly 2», « для типа «Кастомы»»; empty for everything. */
  where: string
  models: readonly ModelCode[]
}

function scopeTarget(state: MockState, scope: ThresholdScope, value: string | null): ScopeTarget {
  const everything = { label: null, where: '', models: state.principal.models }
  if (scope === 'all' || value === null) return everything
  if (scope === 'type') {
    const type = ItemTypeSchema.safeParse(value)
    if (!type.success) throw new DomainError('invalid_request', 'Такого типа нет')
    const label = ITEM_TYPE_INFO[type.data].folder
    return { label, where: ` для типа «${label}»`, models: state.principal.models }
  }
  for (const { model } of state.world.models.values()) {
    if (scope === 'model' && model.code === value) {
      return { label: model.name, where: ` для модели ${model.name}`, models: [model.code] }
    }
    const account = model.accounts.find((candidate) => candidate.code === value)
    if (scope === 'account' && account) {
      return { label: account.label, where: ` для страницы ${account.label}`, models: [model.code] }
    }
  }
  throw notFound(scope === 'model' ? 'Такой модели нет' : 'Такой страницы нет')
}

function rowOf(
  state: MockState,
  key: Threshold['key'],
  scope: ThresholdScope,
  value: string | null,
): Threshold | undefined {
  return state.world.thresholds.find(
    (row) => row.key === key && row.scope === scope && row.scope_value === value,
  )
}

function baseOf(state: MockState, key: Threshold['key']): Threshold {
  const base = rowOf(state, key, 'all', null)
  if (!base) throw notFound('Такого порога нет')
  return base
}

function valueWord(value: number | null): string {
  return value === null ? 'не задано' : String(value)
}

/** «Слишком рано» · Fansly 2. */
function fieldOf(threshold: Threshold, target: ScopeTarget): string {
  return target.label ? `${threshold.label} · ${target.label}` : threshold.label
}

/** A new exception goes right after the other rows of its key, so the list stays grouped. */
function insertException(state: MockState, row: Threshold): void {
  const rows = state.world.thresholds
  const last = rows.findLastIndex((candidate) => candidate.key === row.key)
  rows.splice(last + 1, 0, row)
}

export function thresholdHandlers(): BoundRoute[] {
  return [
    bind(adminRoutes.thresholds, 'staff', ({ state }) => wholeList(state.world.thresholds)),
    bind(adminRoutes.updateThreshold, 'owner', ({ state, body, if_match, log }) => {
      const base = baseOf(state, body.key)
      const target = scopeTarget(state, body.scope, body.scope_value)
      const existing = rowOf(state, body.key, body.scope, body.scope_value)
      if (!existing) {
        // The exception was removed while the edit was open: nothing to change by version.
        if (if_match !== null) throw notFound('Этого исключения уже нет')
        const created: Threshold = {
          ...base,
          value: body.value,
          scope: body.scope,
          scope_value: body.scope_value,
          version: 1,
        }
        insertException(state, created)
        logSettingsChange(log, target.models, {
          action: 'threshold.add',
          phrase: `${actorSays(state, 'задал')} порог ${base.label}${target.where}`,
          changes: [
            {
              field: fieldOf(base, target),
              before: `как для всего: ${valueWord(base.value)}`,
              after: valueWord(body.value),
            },
          ],
        })
        return created
      }
      checkVersion(state, if_match, existing, {
        field: fieldOf(existing, target),
        rival: (record) => {
          record.value = RIVAL_THRESHOLD[record.key]
        },
        valueOf: (record) => record.value,
      })
      const before = existing.value
      existing.value = body.value
      existing.version += 1
      logSettingsChange(log, target.models, {
        action: 'threshold.update',
        phrase: `${actorSays(state, 'изменил')} порог ${existing.label}${target.where}`,
        changes: [
          {
            field: fieldOf(existing, target),
            before: valueWord(before),
            after: valueWord(body.value),
          },
        ],
      })
      return existing
    }),
    bind(adminRoutes.removeThreshold, 'owner', ({ state, body, if_match, log }) => {
      if (body.scope === 'all') {
        throw new DomainError(
          'invalid_request',
          'Порог для всего не убирается: пустое значение выключает функцию',
        )
      }
      const target = scopeTarget(state, body.scope, body.scope_value)
      const existing = rowOf(state, body.key, body.scope, body.scope_value)
      if (!existing) throw notFound('Этого исключения уже нет')
      checkVersion(state, if_match, existing, {
        field: fieldOf(existing, target),
        rival: (record) => {
          record.value = RIVAL_THRESHOLD[record.key]
        },
        valueOf: (record) => record.value,
      })
      const base = baseOf(state, body.key)
      state.world.thresholds.splice(state.world.thresholds.indexOf(existing), 1)
      logSettingsChange(log, target.models, {
        action: 'threshold.remove',
        phrase: `${actorSays(state, 'убрал')} порог ${existing.label}${target.where}`,
        changes: [
          {
            field: fieldOf(existing, target),
            before: valueWord(existing.value),
            after: `как для всего: ${valueWord(base.value)}`,
          },
        ],
      })
      return { ok: true as const }
    }),
  ]
}
