import { z } from 'zod'
import { InstantSchema, ModelCodeSchema, ProgressSchema, RecordVersionSchema } from './common'
import { IntegrationLineSchema } from './integrations'

/** Counters of the left column for every model of the principal, one request. */
export const ModelCountersSchema = z.object({
  model: ModelCodeSchema,
  /** Groups of «Приехало» that need a person: ◆, ▲ and «готово». */
  inbox: z.int().nonnegative(),
  /** My rows for today that need a step, «сверить» included. */
  plan: z.int().nonnegative(),
  /** The plan number turns red only when there is ▲ «пропущено». */
  plan_missed: z.boolean(),
  /** A dot on the avatar when the model has ◆ or ▲. */
  attention: z.boolean(),
})
export type ModelCounters = z.infer<typeof ModelCountersSchema>

/** The space card at the bottom of the column. */
export const SpaceCardSchema = z.object({
  /** «C: свободно 612 ГБ»; after the move — «Занято 0,52 из 2 ТБ». */
  label: z.string(),
  used_fraction: ProgressSchema,
  /** Lines only when something is wrong (DESIGN §3.11). */
  alerts: z.array(IntegrationLineSchema),
})
export type SpaceCard = z.infer<typeof SpaceCardSchema>

/** `GET /api/v1/admin/counters` — polled every 30 s. */
export const CountersSchema = z.object({
  models: z.array(ModelCountersSchema),
  space: SpaceCardSchema,
  generated_at: InstantSchema,
})
export type Counters = z.infer<typeof CountersSchema>

export const QueueSchema = z.object({
  key: z.enum(['fetch', 'preview', 'compress', 'frames', 'copies']),
  label: z.string(),
  pending: z.int().nonnegative(),
  progress: ProgressSchema.nullable(),
  paused: z.boolean(),
})
export type Queue = z.infer<typeof QueueSchema>

/**
 * A disk of the space card and «Состояние». On the pilot the numbers come from Windows (the
 * VM disks grow, SPEC §12.2); `null` — «нет данных»: the host has not reported for 15 min.
 */
export const DiskSchema = z.object({
  name: z.string(),
  free_bytes: z.int().nonnegative().nullable(),
  total_bytes: z.int().positive().nullable(),
  warn_below_bytes: z.int().nonnegative(),
  stop_below_bytes: z.int().nonnegative(),
  measured_at: InstantSchema.nullable(),
})
export type Disk = z.infer<typeof DiskSchema>

/** `GET /api/v1/admin/state` — «Настройки › Состояние». */
export const SystemStateSchema = z.object({
  queues: z.array(QueueSchema),
  disks: z.array(DiskSchema),
  backup: z.object({
    /** «Бэкапа нет (пилот)». */
    text: z.string(),
    last_full_at: InstantSchema.nullable(),
    last_dump_at: InstantSchema.nullable(),
  }),
  /** `null` until ContentOps reads Hub (stage 5). */
  hub_latency: z
    .object({
      typical_hours: z.number(),
      max_hours: z.number(),
      wait_window_hours: z.number(),
      /** Present when Hub is slower than the «ждём» window. */
      warning: z.string().nullable(),
    })
    .nullable(),
  storage_findings: z.array(z.string()),
  ai_spend: z.string().nullable(),
  cross_model_duplicates: z.int().nonnegative().nullable(),
})
export type SystemState = z.infer<typeof SystemStateSchema>

export const ThresholdScopeSchema = z.enum(['all', 'model', 'account', 'type'])
export type ThresholdScope = z.infer<typeof ThresholdScopeSchema>

/**
 * A threshold; an empty value means the function is off, and the screen says so.
 * One row per key covers everything (`all`); exceptions for a model, a page or a type sit
 * next to it under the same key with `scope_value` = model code, page code or item type.
 */
export const ThresholdSchema = z.object({
  key: z.enum([
    'too_early_days',
    'time_tolerance_min',
    'duration_tolerance_ms',
    'wait_hub_hours',
    'not_published_hours',
    'album_walk_reminder_days',
    'frame_similarity',
    'auto_accept',
  ]),
  label: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
  scope: ThresholdScopeSchema,
  scope_value: z.string().nullable(),
  version: RecordVersionSchema,
})
export type Threshold = z.infer<typeof ThresholdSchema>
export type ThresholdKey = Threshold['key']

/** What a threshold is asked for: the page, the type of the object and the model. */
export interface ThresholdTarget {
  model?: string | null
  account?: string | null
  type?: string | null
}

/** The most specific exception wins: page, then type, then model, then the row for everything. */
const SCOPE_PRIORITY: readonly ThresholdScope[] = ['account', 'type', 'model', 'all']

function targetValue(scope: ThresholdScope, target: ThresholdTarget): string | null {
  if (scope === 'account') return target.account ?? null
  if (scope === 'type') return target.type ?? null
  if (scope === 'model') return target.model ?? null
  return null
}

/** The value that applies to the target; `null` — not set, the function is off. */
export function thresholdFor(
  thresholds: readonly Threshold[],
  key: ThresholdKey,
  target: ThresholdTarget = {},
): number | null {
  for (const scope of SCOPE_PRIORITY) {
    const wanted = targetValue(scope, target)
    if (scope !== 'all' && wanted === null) continue
    const row = thresholds.find(
      (entry) => entry.key === key && entry.scope === scope && entry.scope_value === wanted,
    )
    if (row) return row.value
  }
  return null
}
