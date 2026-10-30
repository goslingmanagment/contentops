import type { Clock } from '@contentops/contracts/clock'
import { z } from 'zod'

/** `?demo=` states of the prototype (DESIGN §9.1); there is no switcher on screen. */
export const DemoModeSchema = z.enum([
  'loading',
  'empty',
  'error',
  'conflict',
  'hub-off',
  'hub-unset',
  'hub-down',
  'disk-off',
  'ai-off',
  'ai-on',
  'all-off',
  'peak',
  'cases',
  /** Every request answers 401 until the person signs in again (DESIGN §3.10). */
  'signed-out',
])
export type DemoMode = z.infer<typeof DemoModeSchema>

/** `?as=` — who is looking: Диана (КМ), Дмитрий (владелец) or Fyper (только чтение). */
export const PrototypeRoleSchema = z.enum(['km', 'owner', 'reader'])
export type PrototypeRole = z.infer<typeof PrototypeRoleSchema>

export interface MockOptions {
  demo?: DemoMode | null
  role?: PrototypeRole
  /** Answer delay; `false` answers at once (tests). Default 80–300 ms. */
  latency?: { min_ms: number; max_ms: number } | false
  /** «Сейчас»; by default 22.09.2026 14:20 МСК, moving with real time. */
  clock?: Clock
  /** How long long operations take; default 4 s. */
  operation_ms?: number
  /** Mutating requests allowed per window before 429; default 30 per 10 s. */
  rate_limit?: { requests: number; window_ms: number }
}
