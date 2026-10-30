import { randomUUID } from 'node:crypto'
import {
  type BootstrapConfig,
  bootstrap,
  type Db,
  isSwitchOn,
  logAction,
  SYSTEM_ACTOR,
  type Tx,
  values,
  withActorTx,
} from '@contentops/db'
import { sql } from 'drizzle-orm'
import { newSecret, sha256, TOKEN_PREFIX, TOKEN_PREFIX_LENGTH } from '../auth/secrets'

/**
 * What the smoke checks write into (PLAN 6, `ops/smoke.sh`): the model `smoke` with fictional
 * pages, a promo channel and no sources, so nothing reaches Hub or a cloud; its counters have
 * no legacy, so acceptance issues numbers at once. The smoke agent reads every model and
 * writes only here (`smoke/run.ts` refuses any other write). Nothing of it is ever deleted.
 */
export const SMOKE_MODEL = 'smoke'
export const SMOKE_CHANNEL = 'smoke-promo'
export const SMOKE_CONTRACTOR = 'Проверочный подрядчик'
export const SMOKE_PAGES = ['smoke-1', 'smoke-2'] as const
const SMOKE_AGENT_LOGIN = 'agent-smoke'
const SMOKE_AGENT_NAME = 'Смоук-проверки'

export const SMOKE_MODEL_CONFIG: BootstrapConfig['models'][number] = {
  code: SMOKE_MODEL,
  title: 'Проверки',
  title_genitive: 'Проверок',
  timezone: 'Europe/Moscow',
  accounts: SMOKE_PAGES.map((code, index) => ({
    code,
    platform: 'fansly' as const,
    title: `Проверка ${index + 1}`,
    handle: `contentops-smoke-${index + 1}`,
    hub_page_ref: null,
    default_uniq_level: null,
    surfaces: [
      { kind: 'wall' as const, auto_match: false },
      { kind: 'story' as const, auto_match: false },
      { kind: 'vault' as const, auto_match: false },
    ],
  })),
  promo_channels: [{ code: SMOKE_CHANNEL, title: 'Проверочный канал' }],
  sources: [],
  id_counters: Object.fromEntries(
    values.contentTypes.map((type) => [type, { next_number: 1, legacy: false }]),
  ) as BootstrapConfig['models'][number]['id_counters'],
}

export interface SmokeSetupResult {
  created: string[]
  agent: string
  models: string[]
  /** The new token, shown once (`--token`); earlier smoke tokens are revoked. */
  token: string | null
  agents_enabled: boolean
}

/** The first owner as bootstrap knows them: it only finds them, nothing of theirs changes. */
async function owner(db: Db): Promise<BootstrapConfig['owner']> {
  const { rows } = await db.execute<{ login: string; name: string; gender: 'f' | 'm' | null }>(sql`
    SELECT login, display_name AS name, gender FROM principals
     WHERE role = 'owner' AND kind = 'human' AND disabled_at IS NULL
     ORDER BY created_at LIMIT 1`)
  const row = rows[0]
  if (!row) throw new Error('no owner yet: run bootstrap first (ops/README.md)')
  return {
    login: row.login,
    display_name: row.name,
    gender: row.gender ?? 'm',
    password_env: 'CONTENTOPS_OWNER_PASSWORD',
  }
}

async function ensureContractor(tx: Tx, created: string[]): Promise<void> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO contractors (model_id, name, channel_id, format)
    SELECT m.id, ${SMOKE_CONTRACTOR}, c.id, 'master'
      FROM models m JOIN promo_channels c ON c.model_id = m.id AND c.code = ${SMOKE_CHANNEL}
     WHERE m.code = ${SMOKE_MODEL}
    ON CONFLICT ON CONSTRAINT contractors_name DO NOTHING
    RETURNING id`)
  if (rows[0]) created.push(`contractor ${SMOKE_MODEL}/${SMOKE_CONTRACTOR}`)
}

/** The agent `agent-smoke`: role manager, every live model (new ones join on a repeat). */
async function ensureAgent(tx: Tx, created: string[]): Promise<{ id: string; models: string[] }> {
  const { rows: found } = await tx.execute<{ id: string }>(sql`
    INSERT INTO principals (kind, login, display_name, role)
    VALUES ('agent', ${SMOKE_AGENT_LOGIN}, ${SMOKE_AGENT_NAME}, 'manager')
    ON CONFLICT (login) DO NOTHING
    RETURNING id`)
  let id = found[0]?.id
  if (id) created.push(`agent ${SMOKE_AGENT_NAME}`)
  else {
    const { rows } = await tx.execute<{ id: string; kind: string; disabled: boolean }>(sql`
      SELECT id, kind, disabled_at IS NOT NULL AS disabled FROM principals
       WHERE login = ${SMOKE_AGENT_LOGIN}`)
    const row = rows[0]
    if (row?.kind !== 'agent') throw new Error(`${SMOKE_AGENT_LOGIN} is not an agent`)
    if (row.disabled) throw new Error('the smoke agent is disabled: the owner turned it off')
    id = row.id
  }
  const { rows: grants } = await tx.execute<{ code: string }>(sql`
    INSERT INTO principal_grants (model_id, principal_id)
    SELECT m.id, ${id}::uuid FROM models m
     WHERE m.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM principal_grants g
                        WHERE g.model_id = m.id AND g.principal_id = ${id}::uuid
                          AND g.revoked_at IS NULL)
    RETURNING (SELECT code FROM models WHERE id = model_id)`)
  for (const grant of grants) created.push(`grant ${SMOKE_AGENT_NAME} → ${grant.code}`)
  if (found[0] || grants.length > 0) {
    await logAction(tx, {
      modelId: null,
      subjectKind: 'principals',
      subjectId: id,
      subjectLabel: SMOKE_AGENT_NAME,
      after: { Роль: 'Контент-менеджер', Модели: grants.map((grant) => grant.code).join(', ') },
    })
  }
  const { rows: models } = await tx.execute<{ code: string }>(sql`
    SELECT m.code FROM principal_grants g JOIN models m ON m.id = g.model_id
     WHERE g.principal_id = ${id}::uuid AND g.revoked_at IS NULL AND m.archived_at IS NULL
     ORDER BY m.id`)
  return { id, models: models.map((model) => model.code) }
}

async function issueToken(tx: Tx, agentId: string): Promise<string> {
  const { rows: revoked } = await tx.execute<{ id: string; token_prefix: string }>(sql`
    UPDATE api_tokens SET revoked_at = now()
     WHERE principal_id = ${agentId}::uuid AND revoked_at IS NULL
    RETURNING id, token_prefix`)
  for (const token of revoked) {
    await logAction(tx, {
      modelId: null,
      subjectKind: 'api_tokens',
      subjectId: token.id,
      subjectLabel: SMOKE_AGENT_NAME,
      before: { Токен: `${token.token_prefix}… · действует` },
      after: { Токен: `${token.token_prefix}… · отозван` },
    })
  }
  const secret = newSecret(TOKEN_PREFIX)
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO api_tokens (principal_id, name, token_hash, token_prefix)
    VALUES (${agentId}::uuid, ${SMOKE_AGENT_NAME}, ${sha256(secret)},
            ${secret.slice(0, TOKEN_PREFIX_LENGTH)})
    RETURNING id`)
  await logAction(tx, {
    modelId: null,
    subjectKind: 'api_tokens',
    subjectId: rows[0]?.id ?? null,
    subjectLabel: SMOKE_AGENT_NAME,
    after: { Токен: `${secret.slice(0, TOKEN_PREFIX_LENGTH)}…`, Срок: 'бессрочно' },
  })
  return secret
}

/**
 * `ops.js smoke-setup [--token]`: the smoke model through the ordinary bootstrap (a repeat
 * changes nothing), its contractor, the smoke agent with every live model, and with `--token`
 * a new token of that agent (the earlier ones are revoked). Agents work only while the owner
 * keeps «Агенты» on (SPEC §8): this command never turns it on, it only says how it is.
 */
export async function smokeSetup(
  db: Db,
  options: { token: boolean; log?: (line: string) => void },
): Promise<SmokeSetupResult> {
  const config = { models: [SMOKE_MODEL_CONFIG], owner: await owner(db) }
  const { created } = await bootstrap(db, config, options.log ? { log: options.log } : {})
  const context = {
    actor: SYSTEM_ACTOR('smoke-setup'),
    action: 'smoke.setup',
    requestId: randomUUID(),
  }
  const result = await withActorTx(db, context, async (tx) => {
    await ensureContractor(tx, created)
    const agent = await ensureAgent(tx, created)
    const token = options.token ? await issueToken(tx, agent.id) : null
    return { agent, token }
  })
  return {
    created,
    agent: SMOKE_AGENT_NAME,
    models: result.agent.models,
    token: result.token,
    agents_enabled: await isSwitchOn(db, 'agents.enabled'),
  }
}
