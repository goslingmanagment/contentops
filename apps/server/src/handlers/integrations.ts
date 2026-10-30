import type { IntegrationView } from '@contentops/contracts/api/responses'
import {
  INTEGRATION_NAME,
  type Integration,
  type IntegrationSwitches,
} from '@contentops/contracts/domain/integrations'
import { describeIntegration } from '@contentops/contracts/integration-line'
import { logAction, type Queryable, resumeSwitch, type Tx } from '@contentops/db'
import { sql } from 'drizzle-orm'
import { instantOrNull, requireActor } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { startMatching } from '../hub/match/auto'
import { type HubPageState, hubPageStates } from '../hub/views'
import { cloudSources, hasCredentials, type SourceRow } from '../intake/source-client'
import type { Services } from '../services'
import { modelViews } from './models'
import { withFieldErrors } from './shared'

/**
 * «Интеграции» (DESIGN §4.19, SPEC §8): each switch is a `policy_settings` row; no row means
 * off, so a fresh install has everything off. A missing secret in the environment is «не
 * настроено» whatever the switch says. «Временно недоступно» comes from the workers that
 * talk to the source; until they run nothing is down. Hub has three switches per page —
 * «Получать данные», «Автосверка», «Публикация» — and is told by its own freshness: «Hub ·
 * посты на 18:32», older than a day — «не обновлял посты с …» (SPEC §7, §8). Ids are
 * `hub.lora-1`, `ydisk.lora`: a `:` would break `…/{integration}:connect` (Fastify decodes
 * `%3A` before matching).
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
  publish: 'Публикация',
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
  /** The cloud folder of `ydisk.<model>` / `dropbox.<model>`; `null` — not configured. */
  source?: SourceRow | null
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
        publish: { key: 'hub.publish', modelId, accountId },
      }
    case 'ydisk':
      return { scan: { key: 'ydisk.scan', modelId, accountId: null } }
    case 'dropbox':
      return { scan: { key: 'dropbox.scan', modelId, accountId: null } }
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
  if (kind === 'ydisk' || kind === 'dropbox') {
    return `${INTEGRATION_NAME[kind]} · ${entry.scope.modelName}`
  }
  return INTEGRATION_NAME[kind]
}

/** The main switch: without it the integration is off. Hub without «Автосверка» still works. */
const MAIN: Partial<Record<Integration['kind'], SwitchName>> = {
  hub: 'receive',
  ydisk: 'scan',
  dropbox: 'scan',
  agents: 'enabled',
  fyper: 'enabled',
}

async function entries(q: Queryable, models: readonly string[]): Promise<Entry[]> {
  const views = await modelViews(q, models)
  const sources = await cloudSources(q)
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
    // Both clouds of every model: a model without the folder or the token is «не настроено».
    for (const kind of ['dropbox', 'ydisk'] as const) {
      const source =
        sources.find(
          (row) =>
            row.modelCode === model.code &&
            row.kind === (kind === 'ydisk' ? 'yandex_disk' : 'dropbox'),
        ) ?? null
      const scope = { ...modelScope, source }
      list.push({ integration: base(`${kind}.${model.code}`, kind, scope), scope })
    }
    for (const account of model.accounts) {
      const scope: Scope = {
        ...modelScope,
        accountId: ids.find((row) => row.code === account.code)?.id ?? null,
        accountCode: account.code,
        accountLabel: account.label,
        hubPage: account.hub_page,
      }
      list.push({ integration: base(`hub.${account.code}`, 'hub', scope), scope })
    }
  }
  for (const kind of ['ai', 'fyper', 'agents'] as const) {
    list.push({ integration: base(kind, kind, none), scope: none })
  }
  return list
}

/** What the scans of a source last said: success, a refused token, an outage with a retry. */
interface ScanHealth {
  scope: string
  last_ok_at: string | null
  failed_code: string | null
  failed_at: string | null
  retry_code: string | null
  retry_at: string | null
}

async function scanHealth(q: Queryable): Promise<ScanHealth[]> {
  const { rows } = await q.execute<ScanHealth & Record<string, unknown>>(sql`
    SELECT w.scope,
           max(w.finished_at) FILTER (WHERE w.state = 'succeeded') AS last_ok_at,
           (array_agg(w.error_code ORDER BY w.finished_at DESC)
              FILTER (WHERE w.state IN ('succeeded', 'failed')))[1] AS failed_code,
           (array_agg(w.finished_at ORDER BY w.finished_at DESC)
              FILTER (WHERE w.state IN ('succeeded', 'failed')))[1] AS failed_at,
           (array_agg(w.error_code ORDER BY w.created_at DESC)
              FILTER (WHERE w.state = 'retry_wait' AND w.paused_reason IS NULL))[1] AS retry_code,
           (array_agg(w.next_attempt_at ORDER BY w.created_at DESC)
              FILTER (WHERE w.state = 'retry_wait' AND w.paused_reason IS NULL))[1] AS retry_at
      FROM work_operations w
     WHERE w.kind = 'scan' AND w.scope IS NOT NULL
     GROUP BY w.scope`)
  return rows
}

interface ViewContext {
  secrets: Services['secrets']
  env: Services['sourceEnv']
  health: readonly ScanHealth[]
  /** The Hub poll of each page by account id; a page without it is told as working. */
  hub?: ReadonlyMap<string, HubPageState>
}

function sourceState(integration: Integration, entry: Entry, context: ViewContext) {
  const source = entry.scope.source
  if (!source) return
  const health = context.health.find((row) => row.scope === source.id)
  integration.last_ok_at = instantOrNull(health?.last_ok_at)
  if (health?.failed_code === 'auth_rejected') {
    integration.state = 'down'
    integration.down_reason = 'token_rejected'
    integration.since = instantOrNull(health.failed_at)
  } else if (health?.retry_code) {
    integration.state = 'down'
    integration.down_reason = 'unreachable'
    integration.retry_at = instantOrNull(health.retry_at)
  }
}

function hubState(integration: Integration, entry: Entry, context: ViewContext) {
  const page = entry.scope.accountId ? context.hub?.get(entry.scope.accountId) : undefined
  if (!page) return
  integration.last_ok_at = page.postsAt
  if (page.state === 'down') {
    integration.state = 'down'
    integration.down_reason = page.downReason
    integration.since = page.since
    integration.retry_at = page.retryAt
  }
}

function view(
  entry: Entry,
  policies: readonly PolicyRow[],
  context: ViewContext,
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
  const cloud = integration.kind === 'ydisk' || integration.kind === 'dropbox'
  const configured =
    integration.kind === 'hub'
      ? context.secrets.hub && entry.scope.hubPage !== null
      : cloud
        ? Boolean(entry.scope.source && hasCredentials(context.env, entry.scope.source))
        : integration.kind !== 'ai'
  if (!configured) integration.state = 'unset'
  else if (main && !integration.switches[main]) {
    integration.state = 'off'
    integration.since = instantOrNull(mainSince)
  } else {
    integration.state = 'working'
    if (cloud) sourceState(integration, entry, context)
    if (integration.kind === 'hub') hubState(integration, entry, context)
  }
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
     WHERE key IN ('hub.receive', 'hub.auto_match', 'hub.publish', 'ydisk.scan',
                   'dropbox.scan', 'agents.enabled', 'fyper.enabled')
       AND item_type IS NULL`)
  return rows
}

/** The integrations of the models as «Интеграции» shows them, for the plan's Hub lines. */
export async function integrationViews(
  q: Queryable,
  services: Pick<Services, 'secrets' | 'sourceEnv'>,
  models: readonly string[],
): Promise<IntegrationView[]> {
  const list = await entries(q, models)
  const rows = await policies(q)
  const context: ViewContext = {
    secrets: services.secrets,
    env: services.sourceEnv,
    health: await scanHealth(q),
    hub: await hubPageStates(q, new Date()),
  }
  const now = new Date().toISOString()
  return list.map((entry) => view(entry, rows, context, now))
}

const WORD = (on: boolean) => (on ? 'включено' : 'выключено')

/**
 * Sets switches of one integration (DESIGN §4.19) with the journal row «было → стало»: the
 * owner's «Интеграции» and `ops.js switch` in the VM shell (`ops/README.md`). Turning one on
 * releases the works it held; «Автосверка» on starts the page's matching (SPEC §7).
 */
export async function applySwitches(
  tx: Tx,
  by: { models: readonly string[]; actorId: string | null },
  integrationId: string,
  switches: Partial<Record<SwitchName, boolean | undefined>>,
): Promise<Entry> {
  const entry = (await entries(tx, by.models)).find(
    (candidate) => candidate.integration.id === integrationId,
  )
  if (!entry) throw new ApiProblem('not_found', 'Такой интеграции нет')
  const targets = targetsOf(entry)
  const asked = Object.entries(switches).filter(
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
              ${JSON.stringify(value)}::jsonb, ${by.actorId}::uuid)
      ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
         SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by,
             row_version = policy_settings.row_version + 1`)
    now[SWITCH_LABEL[name]] = WORD(value)
    // Works paused by this switch go on where it is on now (schema §9.2).
    if (value) await resumeSwitch(tx, target.key)
    // «Автосверка» on for the first time: the history pass of the page and the start of
    // matching (SPEC §7); a repeat finds the same work.
    if (value && name === 'auto_match' && target.modelId && target.accountId) {
      await startMatching(tx, { modelId: target.modelId, accountId: target.accountId })
    }
  }
  await logAction(tx, {
    modelId: entry.scope.modelId,
    subjectKind: 'integration',
    subjectLabel: subjectOf(entry),
    before: was,
    after: now,
  })
  return entry
}

/** On or off of every switch of an integration, as «Интеграции» shows them. */
export async function switchesOf(
  q: Queryable,
  models: readonly string[],
  integrationId: string,
): Promise<Partial<Record<SwitchName, boolean>>> {
  const entry = (await entries(q, models)).find(
    (candidate) => candidate.integration.id === integrationId,
  )
  if (!entry) throw new ApiProblem('not_found', 'Такой интеграции нет')
  const rows = await policies(q)
  return Object.fromEntries(
    (Object.entries(targetsOf(entry)) as [SwitchName, SwitchTarget][]).map(([name, target]) => [
      name,
      switchState(rows, target).on,
    ]),
  )
}

export function integrationHandlers({
  db,
  command,
  secrets,
  sourceEnv,
}: Services): HandlerRegistry {
  const contextOf = async (q: Queryable): Promise<ViewContext> => ({
    secrets,
    env: sourceEnv,
    health: await scanHealth(q),
    hub: await hubPageStates(q, new Date()),
  })
  return {
    admin: {
      integrations: async ({ ctx }) => {
        const actor = requireActor(ctx)
        const list = await entries(db, actor.models)
        const rows = await policies(db)
        const now = new Date().toISOString()
        const context = await contextOf(db)
        return { items: list.map((entry) => view(entry, rows, context, now)), next_cursor: null }
      },

      updateIntegration: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const entry = await applySwitches(
            tx,
            { models: actor.models, actorId: actor.id },
            params.integration,
            body.switches,
          )
          return view(entry, await policies(tx), await contextOf(tx), new Date().toISOString())
        }),
    },

    settings: {
      /**
       * «Настроить»: Hub gets the page code (`accounts.hub_page_ref`). Keys and addresses live
       * in the server's environment (SPEC §8), Fyper is an agent with a token.
       */
      connectIntegration: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const entry = (await entries(tx, actor.models)).find(
            (candidate) => candidate.integration.id === params.integration,
          )
          if (!entry) throw new ApiProblem('not_found', 'Такой интеграции нет')
          if (entry.integration.kind === 'fyper') {
            throw new ApiProblem('invalid_request', 'Fyper заводится в «Агентах и токенах»')
          }
          if (entry.integration.kind !== 'hub' || !body.hub_page || !entry.scope.accountId) {
            throw new ApiProblem(
              'invalid_request',
              'Ключи и адреса интеграций задаются в окружении сервера',
            )
          }
          const hubPage = body.hub_page
          await withFieldErrors(
            () =>
              tx.execute(sql`
                UPDATE accounts SET hub_page_ref = ${hubPage}, row_version = row_version + 1
                 WHERE model_id = ${entry.scope.modelId}::uuid
                   AND id = ${entry.scope.accountId}::uuid`),
            {
              accounts_hub_page_ref_key: {
                field: 'hub_page',
                message: 'Эта страница Hub уже привязана',
              },
            },
          )
          await logAction(tx, {
            modelId: entry.scope.modelId,
            subjectKind: 'integration',
            subjectLabel: subjectOf(entry),
            before: { 'Код страницы в Hub': entry.scope.hubPage ?? 'не задан' },
            after: { 'Код страницы в Hub': hubPage },
          })
          const connected = { ...entry, scope: { ...entry.scope, hubPage } }
          return view(connected, await policies(tx), await contextOf(tx), new Date().toISOString())
        }),

      /** Cloud markup is stage 8: no services yet, so the section stays hidden (DESIGN §4.19). */
      ai: () => ({ services: [], budget_month_usd: null, spent_month_usd: 0, stopped: null }),
    },
  }
}
