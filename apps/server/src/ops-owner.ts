import { randomUUID } from 'node:crypto'
import { type AgentRole, AgentRoleSchema } from '@contentops/contracts/domain/agents'
import { ROLE_LABEL } from '@contentops/contracts/domain/people'
import {
  type Db,
  isSwitchOn,
  logAction,
  SYSTEM_ACTOR,
  type Tx,
  values,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { newSecret, sha256, TOKEN_PREFIX, TOKEN_PREFIX_LENGTH } from './auth/secrets'
import { applySwitches, switchesOf } from './handlers/integrations'
import { modelNames, modelsByCodes } from './handlers/shared'

/**
 * The owner's commands from the VM shell (`ops.js agent`, `ops.js switch`, ops/README.md): what
 * «Агенты и токены» and «Интеграции» do, for a stack whose owner has no browser session — the
 * operator's import agent, the orders routine's agent, the scan of a source, «Агенты». Owner
 * stays people only (DESIGN §4.19): the agent gets `manager` or `reader`. The journal shows
 * the changes as the system's (`ops`).
 */

const context = (action: string) => ({
  actor: SYSTEM_ACTOR('ops'),
  action,
  requestId: randomUUID(),
})

export interface OpsAgentResult {
  agent: string
  id: string
  role: AgentRole
  models: string[]
  created: boolean
  /** The new token, shown once; the agent's earlier tokens are revoked. */
  token: string | null
  agents_enabled: boolean
}

async function liveModels(tx: Tx, id: string): Promise<string[]> {
  const { rows } = await tx.execute<{ code: string }>(sql`
    SELECT m.code FROM principal_grants g JOIN models m ON m.id = g.model_id
     WHERE g.principal_id = ${id}::uuid AND g.revoked_at IS NULL AND m.archived_at IS NULL
     ORDER BY m.id`)
  return rows.map((row) => row.code)
}

async function newToken(tx: Tx, id: string, name: string): Promise<string> {
  const { rows: revoked } = await tx.execute<{ id: string; token_prefix: string }>(sql`
    UPDATE api_tokens SET revoked_at = now()
     WHERE principal_id = ${id}::uuid AND revoked_at IS NULL
    RETURNING id, token_prefix`)
  for (const token of revoked) {
    await logAction(tx, {
      modelId: null,
      subjectKind: 'api_tokens',
      subjectId: token.id,
      subjectLabel: name,
      before: { Токен: `${token.token_prefix}… · действует` },
      after: { Токен: `${token.token_prefix}… · отозван` },
    })
  }
  const secret = newSecret(TOKEN_PREFIX)
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO api_tokens (principal_id, name, token_hash, token_prefix)
    VALUES (${id}::uuid, ${name}, ${sha256(secret)}, ${secret.slice(0, TOKEN_PREFIX_LENGTH)})
    RETURNING id`)
  await logAction(tx, {
    modelId: null,
    subjectKind: 'api_tokens',
    subjectId: rows[0]?.id ?? null,
    subjectLabel: name,
    after: { Токен: `${secret.slice(0, TOKEN_PREFIX_LENGTH)}…`, Срок: 'бессрочно' },
  })
  return secret
}

/**
 * `ops.js agent <name> --role manager|reader --models a,b [--token]`: the agent by its name —
 * made when there is none, given the models it lacks (none taken away); another role is
 * refused (changed only in «Агенты и токены»). With `--token` a new token, once.
 */
export async function opsAgent(
  db: Db,
  input: { name: string; role: string; models: readonly string[]; token: boolean },
): Promise<OpsAgentResult> {
  const name = input.name.trim()
  if (!name) throw new Error('the agent needs a name')
  const role = AgentRoleSchema.safeParse(input.role)
  if (!role.success) throw new Error(`role ${input.role}: an agent is manager or reader`)
  if (input.models.length === 0) throw new Error('the agent needs --models')
  const result = await withActorTx(db, context('agent.ops'), async (tx) => {
    const models = await modelsByCodes(tx, input.models)
    const { rows: found } = await tx.execute<{ id: string; role: string }>(sql`
      SELECT id, role FROM principals
       WHERE kind = 'agent' AND disabled_at IS NULL AND display_name = ${name}
       ORDER BY id FOR UPDATE`)
    if (found.length > 1) throw new Error(`${found.length} agents are named «${name}»`)
    let id = found[0]?.id
    const created = !id
    if (id && found[0]?.role !== role.data) {
      throw new Error(`«${name}» is ${found[0]?.role}: the role changes in «Агенты и токены»`)
    }
    if (!id) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO principals (kind, login, display_name, role)
        VALUES ('agent', ${`agent-${randomUUID()}`}, ${name}, ${role.data})
        RETURNING id`)
      id = rows[0]?.id
      if (!id) throw new Error('agent insert returned nothing')
    }
    const { rows: granted } = await tx.execute<{ code: string }>(sql`
      INSERT INTO principal_grants (model_id, principal_id)
      SELECT m.id, ${id}::uuid FROM models m
       WHERE m.id = ANY(${sql.param(models.map((model) => model.id))}::uuid[])
         AND NOT EXISTS (SELECT 1 FROM principal_grants g
                          WHERE g.model_id = m.id AND g.principal_id = ${id}::uuid
                            AND g.revoked_at IS NULL)
      RETURNING (SELECT code FROM models WHERE id = model_id) AS code`)
    const now = await liveModels(tx, id)
    if (created || granted.length > 0) {
      await logAction(tx, {
        modelId: null,
        subjectKind: 'principals',
        subjectId: id,
        subjectLabel: name,
        after: { Имя: name, Роль: ROLE_LABEL[role.data], Модели: await modelNames(tx, now) },
      })
    }
    const token = input.token ? await newToken(tx, id, name) : null
    return { id, created, models: now, token }
  })
  return {
    agent: name,
    id: result.id,
    role: role.data,
    models: result.models,
    created: result.created,
    token: result.token,
    agents_enabled: await isSwitchOn(db, 'agents.enabled'),
  }
}

/**
 * `ops.js switch <integration> <name>=on|off …` — the switches of «Интеграции» by its ids:
 * `ydisk.lora scan=on`, `agents enabled=on`, `hub.lora-1 receive=off`.
 */
export async function opsSwitch(
  db: Db,
  integration: string,
  pairs: readonly string[],
): Promise<Record<string, boolean>> {
  const switches: Record<string, boolean> = {}
  for (const pair of pairs) {
    const match = /^([a-z_]+)=(on|off)$/.exec(pair)
    if (!match?.[1]) throw new Error(`${pair}: expected <switch>=on|off`)
    switches[match[1]] = match[2] === 'on'
  }
  if (Object.keys(switches).length === 0) throw new Error('no switch given: <switch>=on|off')
  const { rows } = await db.execute<{ code: string }>(sql`
    SELECT code FROM models WHERE archived_at IS NULL ORDER BY id`)
  const models = rows.map((row) => row.code)
  await withActorTx(db, context('integration.ops'), (tx) =>
    applySwitches(tx, { models, actorId: null }, integration, switches),
  )
  return switchesOf(db, models, integration)
}

export interface OpsPolicyResult {
  key: string
  scope: { model: string | null; page: string | null; type: string | null }
  before: unknown
  value: unknown
}

/**
 * `ops.js policy <key> <json|off> [--model m] [--page p] [--type PPV]` — a value of
 * `policy_settings` (schema §3.1) other than a switch: the thresholds of «Пороги» by their keys
 * (`hub_candidate_tolerance 30`), and what has no screen — `hub_ad_markers` of a page,
 * `import_batch_scope` of a model. `off` — not set (SQL NULL), the function is off there.
 * Switches go through `ops.js switch`.
 */
export async function opsPolicy(
  db: Db,
  input: {
    key: string
    value: string
    model?: string | undefined
    page?: string | undefined
    type?: string | undefined
  },
): Promise<OpsPolicyResult> {
  if (!(values.thresholdKeys as readonly string[]).includes(input.key)) {
    throw new Error(
      `${input.key}: not a policy key (${values.thresholdKeys.join(', ')}); switches — ops.js switch`,
    )
  }
  let value: unknown = null
  if (input.value !== 'off') {
    try {
      value = JSON.parse(input.value)
    } catch {
      throw new Error(`${input.value}: expected JSON (30, "x", [..], {..}) or off`)
    }
    if (value === null) throw new Error('null: use off')
  }
  if (input.type && (input.model || input.page)) throw new Error('--type goes alone')
  if (input.type && !(values.contentTypes as readonly string[]).includes(input.type)) {
    throw new Error(`${input.type}: expected one of ${values.contentTypes.join(', ')}`)
  }
  return withActorTx(db, context('policy.ops'), async (tx) => {
    let modelId: string | null = null
    let accountId: string | null = null
    let label = 'для всего'
    if (input.page) {
      const { rows } = await tx.execute<{ id: string; model_id: string; title: string }>(sql`
        SELECT a.id, a.model_id, a.title FROM accounts a JOIN models m ON m.id = a.model_id
         WHERE a.code = ${input.page}
           ${input.model ? sql`AND m.code = ${input.model}` : sql``}`)
      const account = rows[0]
      if (!account || rows.length > 1) throw new Error(`${input.page}: no such page`)
      modelId = account.model_id
      accountId = account.id
      label = `для страницы ${account.title}`
    } else if (input.model) {
      const { rows } = await tx.execute<{ id: string; title: string }>(sql`
        SELECT id, title FROM models WHERE code = ${input.model}`)
      const model = rows[0]
      if (!model) throw new Error(`${input.model}: no such model`)
      modelId = model.id
      label = `для модели ${model.title}`
    } else if (input.type) {
      label = `для типа ${input.type}`
    }
    const itemType = input.type ?? null
    const { rows: was } = await tx.execute<{ value: unknown }>(sql`
      SELECT value FROM policy_settings
       WHERE key = ${input.key} AND model_id IS NOT DISTINCT FROM ${modelId}::uuid
         AND account_id IS NOT DISTINCT FROM ${accountId}::uuid
         AND item_type IS NOT DISTINCT FROM ${itemType}
       FOR UPDATE`)
    const before = was[0]?.value ?? null
    const { rows: saved } = await tx.execute<{ id: string }>(sql`
      INSERT INTO policy_settings (model_id, account_id, item_type, key, value)
      VALUES (${modelId}::uuid, ${accountId}::uuid, ${itemType}, ${input.key},
              ${value === null ? null : JSON.stringify(value)}::jsonb)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
         SET value = excluded.value, updated_at = now(), updated_by = NULL,
             row_version = policy_settings.row_version + 1
      RETURNING id`)
    const word = (v: unknown) => (v === null ? 'не задано' : JSON.stringify(v))
    await logAction(tx, {
      modelId,
      subjectKind: 'policy_settings',
      subjectId: saved[0]?.id ?? null,
      subjectLabel: `${input.key} ${label}`,
      before: { [input.key]: word(before) },
      after: { [input.key]: word(value) },
    })
    return {
      key: input.key,
      scope: { model: input.model ?? null, page: input.page ?? null, type: itemType },
      before,
      value,
    }
  })
}
