import { randomUUID } from 'node:crypto'
import { type Db, isSwitchOn, logAction, SYSTEM_ACTOR, withActorTx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { HOST_AGENT_KEY } from './release'

export interface HostAgentResult {
  /** The agent the PC's tasks act as now; `null` — none. */
  agent: string | null
  id: string | null
  models: string[]
  agents_enabled: boolean
}

/**
 * `ops.js originals host-agent <name> | --off` (SPEC §9.4, ops/README.md «Оригиналы: два места»):
 * the one agent whose token the Windows tasks of the PC use to ask what they may free
 * (`admin.originalsRelease`). The agent is made with `ops.js agent <name> --role reader --models
 * lora,ari --token`; it reads what the PC holds only for its models. One global policy row,
 * journaled as the system's (`ops`).
 */
export async function opsHostAgent(db: Db, name: string | null): Promise<HostAgentResult> {
  const result = await withActorTx(
    db,
    { actor: SYSTEM_ACTOR('ops'), action: 'originals.hostAgent', requestId: randomUUID() },
    async (tx) => {
      let id: string | null = null
      if (name !== null) {
        const { rows } = await tx.execute<{ id: string }>(sql`
          SELECT id FROM principals
           WHERE kind = 'agent' AND disabled_at IS NULL AND display_name = ${name}
           ORDER BY id`)
        if (rows.length !== 1) {
          throw new Error(
            rows.length === 0
              ? `no agent named «${name}»: make it first (ops.js agent)`
              : `${rows.length} agents are named «${name}»`,
          )
        }
        id = rows[0]?.id ?? null
      }
      const { rows: was } = await tx.execute<{ value: unknown; name: string | null }>(sql`
        SELECT s.value, p.display_name AS name FROM policy_settings s
          LEFT JOIN principals p ON p.id::text = s.value #>> '{}'
         WHERE s.key = ${HOST_AGENT_KEY} AND s.model_id IS NULL AND s.account_id IS NULL
           AND s.item_type IS NULL
         FOR UPDATE OF s`)
      const before = typeof was[0]?.value === 'string' ? (was[0].value as string) : null
      if (before !== id) {
        const { rows: saved } = await tx.execute<{ id: string }>(sql`
          INSERT INTO policy_settings (key, value)
          VALUES (${HOST_AGENT_KEY}, ${id === null ? null : JSON.stringify(id)}::jsonb)
          ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
             SET value = excluded.value, updated_at = now(), updated_by = NULL,
                 row_version = policy_settings.row_version + 1
          RETURNING id`)
        await logAction(tx, {
          modelId: null,
          subjectKind: 'policy_settings',
          subjectId: saved[0]?.id ?? null,
          subjectLabel: 'Агент ПК',
          before: { 'Агент ПК': was[0]?.name ?? 'нет' },
          after: { 'Агент ПК': name ?? 'нет' },
        })
      }
      const { rows: models } = await tx.execute<{ code: string }>(sql`
        SELECT m.code FROM principal_grants g JOIN models m ON m.id = g.model_id
         WHERE g.principal_id = ${id}::uuid AND g.revoked_at IS NULL AND m.archived_at IS NULL
         ORDER BY m.code`)
      return { id, models: models.map((row) => row.code) }
    },
  )
  return {
    agent: name,
    id: result.id,
    models: result.models,
    agents_enabled: await isSwitchOn(db, 'agents.enabled'),
  }
}
