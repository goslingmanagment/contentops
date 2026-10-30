import type { IntegrationView } from '@contentops/contracts/api/responses'
import {
  INTEGRATION_NAME,
  type Integration,
  type IntegrationSwitches,
} from '@contentops/contracts/domain/integrations'
import { describeIntegration } from '@contentops/contracts/integration-line'
import { logAction, type Queryable, resumeSwitch } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instantOrNull, requireActor } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import type { Services } from '../services'
import { modelViews } from './models'

/**
 * «Интеграции» (DESIGN §4.19, SPEC §8): each switch is a `policy_settings` row; no row means
 * off, so a fresh install has everything off. A missing secret in the environment is «не
 * настроено» whatever the switch says. «Временно недоступно» comes from the workers that
 * talk to the source; until they run nothing is down.
 */

type SwitchName = keyof IntegrationSwitches

interface SwitchTarget {
  key: string
  modelId: string | null
  accountId: string | null
}

interface PolicyRow extends Record<string, unknown> {
  key: string
  model_id: string | null
  account_id: string | null
  value: unknown
  updated_at: string
}

const SWITCH_LABEL: Record<SwitchName, string> = {
  receive: 'Получать данные',
  auto_match: 'Автосверка',
  scan: 'Скан по источнику',
  enabled: 'Работают',
}

/** On only when some level says `true` and none says `false` (the rule of `isSwitchOn`). */
function switchState(rows: readonly PolicyRow[], target: SwitchTarget) {
  const levels = rows.filter(
    (row) =>
      row.key === target.key &&
      (row.model_id === null || row.model_id === target.modelId) &&
      (row.account_id === null || row.account_id === target.accountId),
  )
  const on = levels.some((row) => row.value === true) && !levels.some((row) => row.value === false)
  const off = levels.filter((row) => row.value === false).map((row) => row.updated_at)
  return { on, since: off.sort().at(-1) ?? null }
}

interface Scope {
  modelId: string | null
  modelCode: string | null
  accountId: string | null
  accountCode: string | null
  accountLabel: string | null
  modelName: string | null
  hubPage: string | null
}

interface Entry {
  integration: Integration
  scope: Scope
}

function base(id: string, kind: Integration['kind'], scope: Scope): Integration {
  return {
    id,
    kind,
    model: scope.modelCode,
    account: scope.accountCode,
    state: 'unset',
    last_ok_at: null,
    since: null,
    retry_at: null,
    down_reason: null,
    catch_up: null,
    switches: {},
  }
}

/** Which switches an integration has and where each one is stored. */
function targetsOf(entry: Entry): Partial<Record<SwitchName, SwitchTarget>> {
  const { modelId, accountId } = entry.scope
  switch (entry.integration.kind) {
    case 'hub':
      return {
        receive: { key: 'hub.receive', modelId, accountId },
        auto_match: { key: 'hub.auto_match', modelId, accountId },
      }
    case 'ydisk':
      return { scan: { key: 'ydisk.scan', modelId, accountId: null } }
    case 'agents':
      return { enabled: { key: 'agents.enabled', modelId: null, accountId: null } }
    case 'fyper':
      return { enabled: { key: 'fyper.enabled', modelId: null, accountId: null } }
    default:
      return {}
  }
}

/** Name of the integration in the journal: «Hub · Fansly 3», «Я.Диск · Лора». */
function subjectOf(entry: Entry): string {
  const { kind } = entry.integration
  if (kind === 'hub') return `Hub · ${entry.scope.accountLabel}`
  if (kind === 'ydisk') return `Я.Диск · ${entry.scope.modelName}`
  return INTEGRATION_NAME[kind]
}

/** The main switch: without it the integration is off. Hub without «Автосверка» still works. */
const MAIN: Partial<Record<Integration['kind'], SwitchName>> = {
  hub: 'receive',
  ydisk: 'scan',
  agents: 'enabled',
  fyper: 'enabled',
}

async function entries(q: Queryable, models: readonly string[]): Promise<Entry[]> {
  const views = await modelViews(q, models)
  const { rows: ids } = await q.execute<{ id: string; code: string; model_code: string }>(sql`
    SELECT a.id, a.code, m.code AS model_code FROM accounts a JOIN models m ON m.id = a.model_id
     WHERE m.code = ANY(${sql.param([...models])}::text[])`)
  const { rows: modelIds } = await q.execute<{ id: string; code: string }>(sql`
    SELECT id, code FROM models WHERE code = ANY(${sql.param([...models])}::text[])`)
  const none: Scope = {
    modelId: null,
    modelCode: null,
    accountId: null,
    accountCode: null,
    accountLabel: null,
    modelName: null,
    hubPage: null,
  }
  const list: Entry[] = []
  for (const model of views) {
    const modelScope: Scope = {
      ...none,
      modelId: modelIds.find((row) => row.code === model.code)?.id ?? null,
      modelCode: model.code,
      modelName: model.name,
    }
    list.push({ integration: base(`ydisk:${model.code}`, 'ydisk', modelScope), scope: modelScope })
    for (const account of model.accounts) {
      const scope: Scope = {
        ...modelScope,
        accountId: ids.find((row) => row.code === account.code)?.id ?? null,
        accountCode: account.code,
        accountLabel: account.label,
        hubPage: account.hub_page,
      }
      list.push({ integration: base(`hub:${account.code}`, 'hub', scope), scope })
    }
  }
  for (const kind of ['ai', 'fyper', 'agents'] as const) {
    list.push({ integration: base(kind, kind, none), scope: none })
  }
  return list
}

function view(
  entry: Entry,
  policies: readonly PolicyRow[],
  secrets: Services['secrets'],
  now: string,
): IntegrationView {
  const integration: Integration = { ...entry.integration, switches: {} }
  const targets = targetsOf(entry)
  let mainSince: string | null = null
  for (const [name, target] of Object.entries(targets) as [SwitchName, SwitchTarget][]) {
    const state = switchState(policies, target)
    integration.switches[name] = state.on
    if (name === MAIN[integration.kind]) mainSince = state.since
  }
  const main = MAIN[integration.kind]
  const configured =
    integration.kind === 'hub'
      ? secrets.hub && entry.scope.hubPage !== null
      : integration.kind === 'ydisk'
        ? secrets.ydisk
        : integration.kind !== 'ai'
  if (!configured) integration.state = 'unset'
  else if (main && !integration.switches[main]) {
    integration.state = 'off'
    integration.since = instantOrNull(mainSince)
  } else integration.state = 'working'
  return {
    ...integration,
    line: describeIntegration(integration, {
      now,
      accountLabel: entry.scope.accountLabel,
    }),
  }
}

async function policies(q: Queryable): Promise<PolicyRow[]> {
  const { rows } = await q.execute<PolicyRow>(sql`
    SELECT key, model_id, account_id, value, updated_at FROM policy_settings
     WHERE key IN ('hub.receive', 'hub.auto_match', 'ydisk.scan', 'agents.enabled',
                   'fyper.enabled')
       AND item_type IS NULL`)
  return rows
}

const WORD = (on: boolean) => (on ? 'включено' : 'выключено')

export function integrationHandlers({ db, command, secrets }: Services): HandlerRegistry {
  return {
    admin: {
      integrations: async ({ ctx }) => {
        const actor = requireActor(ctx)
        const list = await entries(db, actor.models)
        const rows = await policies(db)
        const now = new Date().toISOString()
        return { items: list.map((entry) => view(entry, rows, secrets, now)), next_cursor: null }
      },

      updateIntegration: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const entry = (await entries(tx, actor.models)).find(
            (candidate) => candidate.integration.id === params.integration,
          )
          if (!entry) throw new ApiProblem('not_found', 'Такой интеграции нет')
          const targets = targetsOf(entry)
          const asked = Object.entries(body.switches).filter(
            (pair): pair is [SwitchName, boolean] => pair[1] !== undefined,
          )
          const missing = asked.filter(([name]) => !targets[name]).map(([name]) => name)
          if (asked.length === 0 || missing.length > 0) {
            throw new ApiProblem('invalid_request', 'Здесь нет такого выключателя', {
              switches: missing,
            })
          }
          const before = await policies(tx)
          const was: Record<string, string> = {}
          const now: Record<string, string> = {}
          for (const [name, value] of asked) {
            const target = targets[name] as SwitchTarget
            was[SWITCH_LABEL[name]] = WORD(switchState(before, target).on)
            await tx.execute(sql`
              INSERT INTO policy_settings (model_id, account_id, key, value, updated_by)
              VALUES (${target.modelId}::uuid, ${target.accountId}::uuid, ${target.key},
                      ${JSON.stringify(value)}::jsonb, ${actor.id}::uuid)
              ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
                 SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by,
                     row_version = policy_settings.row_version + 1`)
            now[SWITCH_LABEL[name]] = WORD(value)
            // Works paused by this switch go on where it is on now (schema §9.2).
            if (value) await resumeSwitch(tx, target.key)
          }
          await logAction(tx, {
            modelId: entry.scope.modelId,
            subjectKind: 'integration',
            subjectLabel: subjectOf(entry),
            before: was,
            after: now,
          })
          return view(entry, await policies(tx), secrets, new Date().toISOString())
        }),
    },

    settings: {
      /** Cloud markup is stage 8: no services yet, so the section stays hidden (DESIGN §4.19). */
      ai: () => ({ services: [], budget_month_usd: null, spent_month_usd: 0, stopped: null }),
    },
  }
}
