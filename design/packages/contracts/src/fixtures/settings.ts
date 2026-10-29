import type { AccountCode, ModelCode } from '../domain/common'
import type { Integration } from '../domain/integrations'
import type { SystemState, Threshold } from '../domain/system'

/** Integrations, thresholds and system state by default (DESIGN §9.8). */

function hub(
  model: ModelCode,
  account: AccountCode,
  patch: Partial<Integration> = {},
): Integration {
  return {
    id: `hub:${account}`,
    kind: 'hub',
    model,
    account,
    state: 'working',
    last_ok_at: '2026-09-22T10:42:00Z',
    since: null,
    retry_at: null,
    down_reason: null,
    catch_up: null,
    switches: { receive: true, auto_match: true },
    ...patch,
  }
}

function service(
  id: string,
  kind: Integration['kind'],
  model: ModelCode | null,
  patch: Partial<Integration>,
): Integration {
  return {
    id,
    kind,
    model,
    account: null,
    state: 'working',
    last_ok_at: null,
    since: null,
    retry_at: null,
    down_reason: null,
    catch_up: null,
    switches: {},
    ...patch,
  }
}

export function buildIntegrations(): Integration[] {
  const ydisk = (model: ModelCode): Integration =>
    service(`ydisk:${model}`, 'ydisk', model, {
      last_ok_at: '2026-09-22T11:16:00Z',
      switches: { scan: true },
    })
  return [
    ydisk('lora'),
    ydisk('lily'),
    ydisk('ari'),
    hub('lora', 'lora-1'),
    hub('lora', 'lora-2'),
    hub('lora', 'lora-3'),
    hub('lora', 'lora-vip-of'),
    hub('lora', 'lora-of', {
      state: 'down',
      since: '2026-09-22T10:52:00Z',
      retry_at: '2026-09-22T11:28:00Z',
      down_reason: 'unreachable',
    }),
    hub('lily', 'lilly-1'),
    hub('lily', 'lilly-2'),
    hub('ari', 'ari-1'),
    hub('ari', 'ari-2', { state: 'unset', last_ok_at: null, switches: {} }),
    service('ai', 'ai', null, { state: 'unset' }),
    service('fyper', 'fyper', null, { state: 'unset' }),
    service('telegram:lora', 'telegram', 'lora', { last_ok_at: '2026-09-22T09:14:00Z' }),
    service('agents', 'agents', null, {
      last_ok_at: '2026-09-22T11:17:00Z',
      switches: { enabled: true },
    }),
  ]
}

export function buildThresholds(): Threshold[] {
  const row = (
    key: Threshold['key'],
    label: string,
    value: number | null,
    unit: string,
  ): Threshold => ({ key, label, value, unit, scope: 'all', scope_value: null, version: 1 })
  return [
    row('too_early_days', '«Слишком рано»', 14, 'дней'),
    // Лайф выходит чаще остального: для него свой порог.
    { ...row('too_early_days', '«Слишком рано»', 7, 'дней'), scope: 'type', scope_value: 'life' },
    row('time_tolerance_min', 'Допуск времени', 30, 'мин'),
    row('duration_tolerance_ms', 'Допуск длительности', 200, 'мс'),
    row('wait_hub_hours', '«Ждём Hub»', 8, 'ч'),
    row('not_published_hours', '«Не вышло»', null, 'ч'),
    row('album_walk_reminder_days', 'Напоминание обхода альбома', 7, 'дней'),
    row('frame_similarity', 'Похожесть кадров', 92, '%'),
    row('auto_accept', 'Автопринятие', null, ''),
  ]
}

const GB = 1_000_000_000

export function buildSystemState(): SystemState {
  return {
    queues: [
      { key: 'fetch', label: 'Забор с диска', pending: 3, progress: null, paused: false },
      { key: 'preview', label: 'Превью', pending: 0, progress: null, paused: false },
      { key: 'compress', label: 'Сжатие', pending: 1, progress: 0.62, paused: false },
      { key: 'frames', label: 'Кадры', pending: 0, progress: null, paused: false },
      { key: 'copies', label: 'Копии для платформы', pending: 1, progress: 0.4, paused: false },
    ],
    disks: [
      {
        name: 'C:',
        free_bytes: 612 * GB,
        total_bytes: 1000 * GB,
        warn_below_bytes: 200 * GB,
        stop_below_bytes: 100 * GB,
      },
      {
        name: 'E:',
        free_bytes: 1100 * GB,
        total_bytes: 2000 * GB,
        warn_below_bytes: 200 * GB,
        stop_below_bytes: 100 * GB,
      },
    ],
    backup: { text: 'Бэкапа нет (пилот)', last_full_at: null, last_dump_at: null },
    hub_latency: {
      typical_hours: 3,
      max_hours: 19,
      wait_window_hours: 8,
      warning: 'Бывает дольше окна «ждём» (8 ч)',
    },
    storage_findings: [],
    ai_spend: null,
    cross_model_duplicates: 1,
  }
}
