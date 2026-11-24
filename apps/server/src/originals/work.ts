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
import type { BlobStore } from '../media/storage'
import { AUDIT_INTERVAL_MS, auditStreamKey, originalsAuditHandler } from './audit'
import { CHECK_INTERVAL_MS, checkStreamKey, originalsCheckHandler } from './check'
import { MODEL_CONFIG_KEY, SWITCH_KEY } from './config'
import { COPY_INTERVAL_MS, copyStreamKey, originalsCopyHandler } from './copy'
import { FREE_INTERVAL_MS, freeStreamKey, originalsFreeHandler } from './free'
import { RcloneTransport } from './rclone'
import type { OriginalsTransport } from './transport'

/**
 * The originals in role `worker` (SPEC §9.4): one rclone for the works that touch the clouds,
 * the streams — the copy and the check every 10 minutes, the audit once a day (the scheduler's
 * day starts at 00:00 UTC, 03:00 in Moscow), the freeing of our disk every 30 minutes (it reads
 * only the ledger) — and the switch `originals.enabled`. They share the slot `originals`: one run
 * at a time, each with `ORIGINALS_STREAMS` streams inside. Without `RCLONE_CONFIG` (or its file)
 * nothing is scheduled, as with any integration without its key; without the switch the works
 * wait (`switch_off:originals.enabled`); a model without `originals.model_config` is not looked
 * at.
 */

export type OriginalsKind =
  | 'originals_check'
  | 'originals_audit'
  | 'originals_copy'
  | 'originals_free'

export interface OriginalsEnv {
  RCLONE_CONFIG?: string | undefined
  RCLONE_BIN?: string | undefined
  /** Streams at once in one run of the check or the copy; default 8. */
  ORIGINALS_STREAMS?: number | undefined
  /** rclone's `--bwlimit` timetable, Moscow time. */
  ORIGINALS_BWLIMIT?: string | undefined
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
  options: { store?: BlobStore | null; transport?: OriginalsTransport } = {},
): OriginalsWorker {
  const { transport } = options
  const config = env.RCLONE_CONFIG
  const clouds =
    transport ??
    (config
      ? new RcloneTransport({
          binary: env.RCLONE_BIN ?? 'rclone',
          config,
          log,
          ...(env.ORIGINALS_BWLIMIT ? { bwlimit: env.ORIGINALS_BWLIMIT } : {}),
        })
      : null)
  const get = () => clouds
  const streams = env.ORIGINALS_STREAMS
  return {
    handlers: {
      originals_check: originalsCheckHandler({ transport: get, ...(streams ? { streams } : {}) }),
      originals_audit: originalsAuditHandler({ transport: get }),
      originals_copy: originalsCopyHandler({
        transport: get,
        store: options.store ?? null,
        ...(streams ? { streams } : {}),
      }),
      originals_free: originalsFreeHandler({ store: options.store ?? null }),
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
        // The copy and the check take turns in the slot.
        {
          streamKey: copyStreamKey,
          kind: 'originals_copy',
          modelId: null,
          intervalMs: COPY_INTERVAL_MS,
          priority: 5,
        },
        // What the ledger lets go from our disk.
        {
          streamKey: freeStreamKey,
          kind: 'originals_free',
          modelId: null,
          intervalMs: FREE_INTERVAL_MS,
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

const STREAM_OF: Record<OriginalsKind, string> = {
  originals_check: checkStreamKey,
  originals_audit: auditStreamKey,
  originals_copy: copyStreamKey,
  originals_free: freeStreamKey,
}

/** `ops.js originals check|audit|copy|free`: a run now (the stream's row when one is waiting). */
export async function enqueueOriginals(db: Db, kind: OriginalsKind) {
  return enqueueWork(db, {
    modelId: null,
    kind,
    workKey: `${STREAM_OF[kind]}:ops:${randomUUID()}`,
    streamKey: STREAM_OF[kind],
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
