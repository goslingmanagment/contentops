import { apiRoutes } from '@contentops/contracts'
import { describe, expect, it } from 'vitest'
import { describeEvent, isServiceAction, type LogRow } from './describe'

/**
 * The journal printed `worker: work.succeeded` and `worker-image: legacy.accept` instead of
 * sentences (DESIGN §4.18): every kind a command or a process writes must read as words.
 */

/** Actions the processes write by name (`logAction({ action })`, the runner's `work.*`). */
const PROCESS_ACTIONS = [
  'draft.accept',
  'draft.accept_on_upload',
  'draft.alias',
  'draft.copy',
  'draft.custom_copy',
  'legacy.accept',
  'legacy.bytes',
  'legacy.pack',
  'legacy.parse',
  'legacy.placements',
  'legacy.reserve',
  'legacy.resolve',
  'legacy.unclear',
  'upload.inbox',
  'inbox.upload',
  'check.decide',
  'hub.ads_hidden',
  'hub.history',
  'hub.history.enqueue',
  'hub.match',
  'hub.publish.checks',
  'hub.sync',
  'hub.sync.failed',
  'hub.sync.rebuilt',
  'source.freeze',
  'source.loss',
  'source.scan',
  'promo.create',
  'promo.prepareHandoff',
  'policy.ops',
  'integration.ops',
  'agent.ops',
  'person.ops',
  'contractor.ops',
  'smoke.setup',
  'upload.purge',
  'bootstrap',
  'principal.create',
  'principal.reset_password',
  'repair.secondPersonUnchecked',
  'repair.shotOnFromExif',
  'work.succeeded',
  'work.retry',
  'work.failed',
  'work.deferred',
  'work.returned',
  'work.paused',
]

const commandActions = Object.entries(apiRoutes).flatMap(([area, routes]) =>
  Object.entries(routes as Record<string, { method: string }>)
    .filter(([, route]) => route.method !== 'GET')
    .map(([name]) => `${area}.${name}`),
)

function row(action: string, actor: LogRow['actor_type'], label: string): LogRow {
  return {
    action,
    actor_type: actor,
    actor_label: label,
    gender: actor === 'human' ? 'f' : null,
    subject_label: 'PPV-073',
    before: null,
    after: { kind: 'fetch', outcome: 'succeeded', attempt: 1, Файлов: '3' },
    result: 'ok',
  }
}

describe('every kind of the journal reads as a sentence (DESIGN §4.18)', () => {
  const kinds = [...new Set([...commandActions, ...PROCESS_ACTIONS])]

  it.each(kinds)('%s', (action) => {
    for (const actor of [
      row(action, 'human', 'Диана'),
      row(action, 'agent', 'Оператор'),
      row(action, 'system', 'worker-video'),
    ]) {
      const { phrase } = describeEvent(actor)
      expect(phrase).not.toContain(action)
      expect(phrase).not.toMatch(/worker|undefined|null|\{subject\}/)
      expect(phrase.length).toBeGreaterThan(8)
    }
  })

  it('refusals and errors say the word and what was refused', () => {
    expect(
      describeEvent({
        ...row('plan.updateNorm', 'agent', 'Агент импорта'),
        result: 'denied',
        after: { code: 'forbidden', status: 403 },
      }).phrase,
    ).toBe('Агент импорта: отказ — изменение нормы: нет прав')
  })

  it('the old corpus is accepted by «Импорт», not by `worker-video`', () => {
    expect(
      describeEvent({
        ...row('legacy.accept', 'system', 'worker-video'),
        after: { Откуда: '1. PPV/Bundles/[PPV-073]_x', 'Старый номер': 'PPV-73' },
      }).phrase,
    ).toBe(
      'Импорт перенёс PPV-073 со старого Я.Диска: «1. PPV/Bundles/[PPV-073]_x», старый номер PPV-73',
    )
    expect(
      describeEvent({
        ...row('draft.accept', 'system', 'worker-video'),
        after: [
          ['Как', 'новый объект PPV-073'],
          ['Файлов', '21'],
        ],
      }).phrase,
    ).toBe('Импорт принял PPV-073: новый объект, 21 файл')
  })

  it('a woman «перенесла» and «завела», not «перенёса»', () => {
    expect(describeEvent(row('legacy.accept', 'human', 'Диана')).phrase).toMatch(
      /^Диана перенесла /,
    )
    expect(describeEvent(row('orders.create', 'human', 'Диана')).phrase).toMatch(/^Диана завела /)
  })

  it('only the queue bookkeeping is service; acceptance and imports are not', () => {
    expect(isServiceAction('work.deferred')).toBe(true)
    expect(isServiceAction('legacy.accept')).toBe(false)
    expect(isServiceAction('draft.accept')).toBe(false)
  })
})
