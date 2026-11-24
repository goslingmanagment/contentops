import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import {
  type Db,
  enqueueWork,
  isSwitchOn,
  logAction,
  type PeriodicStream,
  resumeSwitch,
  SYSTEM_ACTOR,
  type values,
  type WorkHandler,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { AUDIT_INTERVAL_MS, auditStreamKey, originalsAuditHandler } from './audit'
import { CHECK_INTERVAL_MS, checkStreamKey, originalsCheckHandler } from './check'
import { MODEL_CONFIG_KEY, SWITCH_KEY } from './config'
import { RcloneTransport } from './rclone'
import type { OriginalsTransport } from './transport'

/**
 * The originals in role `worker` (SPEC §9.4): one rclone for both works, the streams — the check
 * every 10 minutes, the audit once a day (the scheduler's day starts at 00:00 UTC, 03:00 in
 * Moscow) — and the switch `originals.enabled`. Without `RCLONE_CONFIG` (or its file) nothing is
 * scheduled, as with any integration without its key; without the switch the works wait
 * (`switch_off:originals.enabled`); a model without `originals.model_config` is not looked at.
 */

export interface OriginalsEnv {
  RCLONE_CONFIG?: string | undefined
  RCLONE_BIN?: string | undefined
}

export interface OriginalsWorker {
  handlers: Partial<Record<values.WorkKind, WorkHandler>>
  streams: () => Promise<PeriodicStream[]>
  stop: () => Promise<void>
}

async function readable(path: string | undefined): Promise<boolean> {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function originalsWorker(
  env: OriginalsEnv,
  log: (line: string, error?: unknown) => void,
  transport?: OriginalsTransport,
): OriginalsWorker {
  const config = env.RCLONE_CONFIG
  const clouds =
    transport ??
    (config ? new RcloneTransport({ binary: env.RCLONE_BIN ?? 'rclone', config, log }) : null)
  const get = () => clouds
  return {
    handlers: {
      originals_check: originalsCheckHandler({ transport: get }),
      originals_audit: originalsAuditHandler({ transport: get }),
    },
    streams: async () => {
      if (!clouds || !(transport || (await readable(config)))) return []
      return [
        {
          streamKey: checkStreamKey,
          kind: 'originals_check',
          modelId: null,
          intervalMs: CHECK_INTERVAL_MS,
          priority: 5,
        },
        // Ahead of the check in the slot: the night's listing waits for one check run at most.
        {
          streamKey: auditStreamKey,
          kind: 'originals_audit',
          modelId: null,
          intervalMs: AUDIT_INTERVAL_MS,
          priority: 10,
        },
      ]
    },
    stop: async () => {
      await clouds?.close()
    },
  }
}

/** `ops.js originals check|audit`: a run now (the stream's row when one is waiting). */
export async function enqueueOriginals(db: Db, kind: 'originals_check' | 'originals_audit') {
  return enqueueWork(db, {
    modelId: null,
    kind,
    workKey: `${kind === 'originals_check' ? checkStreamKey : auditStreamKey}:ops:${randomUUID()}`,
    streamKey: kind === 'originals_check' ? checkStreamKey : auditStreamKey,
    priority: 20,
  })
}

export interface SwitchResult {
  enabled: boolean
  resumed: number
  /** Models the works go over: a valid `originals.model_config`. */
  configured: string[]
}

/** `ops.js originals on|off` — the global switch, in the journal as «система · ops». */
export async function setOriginalsSwitch(db: Db, on: boolean): Promise<SwitchResult> {
  return withActorTx(
    db,
    { actor: SYSTEM_ACTOR('ops'), action: 'originals.switch', requestId: randomUUID() },
    async (tx) => {
      const was = await isSwitchOn(tx, SWITCH_KEY)
      await tx.execute(sql`
        INSERT INTO policy_settings (key, value)
        VALUES (${SWITCH_KEY}, ${JSON.stringify(on)}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
           SET value = excluded.value, updated_at = now(),
               row_version = policy_settings.row_version + 1
         WHERE policy_settings.value IS DISTINCT FROM excluded.value`)
      const resumed = on ? await resumeSwitch(tx, SWITCH_KEY) : 0
      if (was !== on) {
        await logAction(tx, {
          modelId: null,
          subjectKind: 'policy_settings',
          subjectLabel: 'Проверка оригиналов',
          before: { Проверка: was ? 'включена' : 'выключена' },
          after: { Проверка: on ? 'включена' : 'выключена' },
        })
      }
      const { rows } = await tx.execute<{ code: string }>(sql`
        SELECT m.code FROM policy_settings p JOIN models m ON m.id = p.model_id
         WHERE p.key = ${MODEL_CONFIG_KEY} AND p.value IS NOT NULL ORDER BY m.code`)
      return { enabled: on, resumed, configured: rows.map((row) => row.code) }
    },
  )
}
