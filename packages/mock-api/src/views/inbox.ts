import { instantMs } from '@contentops/contracts/clock'
import type { Instant } from '@contentops/contracts/domain/common'
import type { InboxGroup, InboxList, PreparingStage } from '@contentops/contracts/domain/inbox'
import { inboxSectionOf } from '@contentops/contracts/domain/inbox'
import { formatPercent } from '@contentops/contracts/format'
import { notFound } from '../domain-error'
import type { InboxRecord, ModelWorld } from '../fixtures/world-types'

/** «Приехало»: groups by what to do, preparing ones finish by themselves (DESIGN §4.8). */

/** The line under a disabled «Принять» while the group is preparing, with its live share. */
const PREPARING_BLOCK: Record<PreparingStage, (progress: number) => string> = {
  discovered: () => 'Ещё качается',
  downloading: () => 'Ещё качается',
  preview: (progress) => `Превью собирается · ${formatPercent(progress)}`,
  compressing: (progress) => `Мастер ещё собирается · ${formatPercent(progress)}`,
  checking: () => 'Проверяется',
}

/** Moves a preparing group forward by the clock; at its `ready_at` it becomes «готово». */
export function advancePreparing(record: InboxRecord, now: Instant) {
  const state = record.group.state
  if (state.kind !== 'preparing' || !record.ready_at || !record.prepare_started_at) return
  const total = instantMs(record.ready_at) - instantMs(record.prepare_started_at)
  const elapsed = instantMs(now) - instantMs(record.prepare_started_at)
  if (elapsed >= total) {
    // Без типа принять нельзя: такая группа ждёт ◆ «Что это?», а не стоит в «Готово».
    if (record.group.fields.type === null) {
      record.group.state = { kind: 'decision', decision: 'what_is_it' }
      record.group.accept_block = 'Сначала выберите тип'
    } else {
      record.group.state = { kind: 'ready', note: record.ready_note ?? { kind: 'new' } }
      record.group.accept_block = null
    }
    record.ready_at = null
    return
  }
  const start = state.progress ?? 0
  const progress = Math.min(0.99, start + ((1 - start) * elapsed) / Math.max(1, total))
  record.group.state = {
    ...state,
    progress,
    done_bytes: state.total_bytes === null ? null : Math.round(state.total_bytes * progress),
  }
  record.group.accept_block = PREPARING_BLOCK[state.stage](progress)
  record.prepare_started_at = now
}

export function inboxRecord(model: ModelWorld, id: string): InboxRecord {
  const record = model.inbox.find((candidate) => candidate.group.id === id)
  if (!record) throw notFound('Такой группы нет')
  return record
}

const SECTION_ORDER = { decision: 0, ready: 1, preparing: 2 } as const

export function inboxList(
  model: ModelWorld,
  now: Instant,
  filter: 'active' | 'accepted' | 'rejected',
): InboxList {
  for (const record of model.inbox) advancePreparing(record, now)
  const groups = model.inbox.map((record) => record.group)
  const visible = groups
    .filter((group) => {
      if (filter === 'active') return inboxSectionOf(group.state) !== null
      return group.state.kind === filter
    })
    .sort((left, right) => {
      const leftSection = inboxSectionOf(left.state)
      const rightSection = inboxSectionOf(right.state)
      const bySection =
        (leftSection ? SECTION_ORDER[leftSection] : 3) -
        (rightSection ? SECTION_ORDER[rightSection] : 3)
      return bySection || right.arrived_at.localeCompare(left.arrived_at)
    })
  return {
    items: visible,
    next_cursor: null,
    count: groups.filter((group) => {
      const section = inboxSectionOf(group.state)
      return section === 'decision' || section === 'ready'
    }).length,
    disk_checked_at: model.disk_checked_at,
    legacy_disputes: model.legacy.disputes.filter((dispute) => !dispute.resolved).length,
  }
}

export function groupView(model: ModelWorld, id: string, now: Instant): InboxGroup {
  const record = inboxRecord(model, id)
  advancePreparing(record, now)
  return record.group
}
