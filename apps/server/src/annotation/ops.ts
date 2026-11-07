import { randomUUID } from 'node:crypto'
import { ITEM_TYPE_INFO, parseItemId } from '@contentops/contracts/domain/item-type'
import { type Db, logAction, resumeSwitch, SYSTEM_ACTOR, values, withActorTx } from '@contentops/db'
import {
  AGGREGATE_FIELDS,
  KNOWN_PRICES,
  type MarkupType,
  type ProviderName,
  type Stage,
} from '@contentops/vision'
import { sql } from 'drizzle-orm'
import { spentSince } from './money'
import {
  type AnnotationSettings,
  annotationKey,
  annotationSettings,
  type Consent,
  ConsentSchema,
  MARKUP_TYPES,
  type Route,
  RouteSchema,
  schemaOfKey,
} from './settings'
import { providerStop } from './stops'
import { enqueueAnnotation, enqueueProbe, type Queued, stagesOf } from './work'

/**
 * The owner's commands of the cloud markup from the VM shell (`ops.js annotation …`,
 * ops/README.md «Разметка ИИ»): consent, budget, limits, routes and switches as rows of
 * `policy_settings` with the journal row «было → стало»; the markup by routes and the
 * measurement put as works of `worker`; the measurement's report as Markdown out of git (it
 * holds what the models wrote about real content). Keys of the providers are never here: they
 * live in `.env` of the stack (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
 */

const PROVIDERS = values.annotationProviders

export function providerOf(name: string): ProviderName {
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(`${name}: a provider is one of ${PROVIDERS.join(', ')}`)
  }
  return name as ProviderName
}

function typeOf(name: string): MarkupType {
  if (!(MARKUP_TYPES as readonly string[]).includes(name)) {
    throw new Error(`${name}: a type is one of ${MARKUP_TYPES.join(', ')}`)
  }
  return name as MarkupType
}

function stageOf(name: string): Stage {
  if (!(values.annotationStages as readonly string[]).includes(name)) {
    throw new Error(`${name}: a stage is one of ${values.annotationStages.join(', ')}`)
  }
  return name as Stage
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)

async function modelIdOf(db: Db, code: string): Promise<string> {
  const { rows } = await db.execute<{ id: string }>(sql`SELECT id FROM models WHERE code = ${code}`)
  const id = rows[0]?.id
  if (!id) throw new Error(`${code}: no such model`)
  return id
}

/** A value through its schema, or an error the owner can read: «запасной поставщик — …». */
function valid<T>(
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } }
  },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(
    `${what}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'} — ${issue.message}`).join('; ')}`,
  )
}

const word = (value: unknown) =>
  value === null || value === undefined ? 'не задано' : JSON.stringify(value)

/**
 * One setting by its key, validated, with the journal row; a value that switches something on
 * releases the works that waited for it (`switch_off:<key>`).
 */
export async function writeAnnotationSetting(
  db: Db,
  key: string,
  value: unknown,
  modelCode?: string,
): Promise<{ key: string; before: unknown; value: unknown }> {
  if (value !== null) {
    const schema = schemaOfKey(key)
    if (schema) {
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        throw new Error(`${key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
      }
      value = parsed.data
    } else if (typeof value !== 'boolean') {
      throw new Error(`${key}: expected on or off`)
    }
  }
  const modelId = modelCode ? await modelIdOf(db, modelCode) : null
  return withActorTx(
    db,
    { actor: SYSTEM_ACTOR('ops'), action: 'policy.ops', requestId: randomUUID() },
    async (tx) => {
      const { rows: was } = await tx.execute<{ value: unknown }>(sql`
        SELECT value FROM policy_settings
         WHERE key = ${key} AND model_id IS NOT DISTINCT FROM ${modelId}::uuid
           AND account_id IS NULL AND item_type IS NULL
         FOR UPDATE`)
      const before = was[0]?.value ?? null
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO policy_settings (model_id, key, value)
        VALUES (${modelId}::uuid, ${key}, ${value === null ? null : JSON.stringify(value)}::jsonb)
        ON CONFLICT ON CONSTRAINT policy_settings_scope DO UPDATE
           SET value = excluded.value, updated_at = now(), updated_by = NULL,
               row_version = policy_settings.row_version + 1
        RETURNING id`)
      await logAction(tx, {
        modelId,
        subjectKind: 'policy_settings',
        subjectId: rows[0]?.id ?? null,
        subjectLabel: `${key} ${modelCode ? `для модели ${modelCode}` : 'для всего'}`,
        before: { [key]: word(before) },
        after: { [key]: word(value) },
      })
      if (value !== null && value !== false) await resumeSwitch(tx, key)
      return { key, before, value }
    },
  )
}

/** `--price gpt-x=1.25/10` → `{ "gpt-x": { input: 1.25, output: 10 } }`. */
export function pricesOf(entries: readonly string[]): Consent['prices'] {
  const prices: Consent['prices'] = {}
  for (const entry of entries) {
    const match = /^([^=\s]+)=([0-9.]+)\/([0-9.]+)$/.exec(entry.trim())
    if (!match?.[1]) throw new Error(`${entry}: expected <model>=<input $/1M>/<output $/1M>`)
    prices[match[1]] = { input: Number(match[2]), output: Number(match[3]) }
  }
  return prices
}

/** `openai:gpt-x[:low],anthropic:claude-opus-5-5` → the providers of a route. */
export function routeProvidersOf(value: string): Route['providers'] {
  return list(value).map((part) => {
    const [provider = '', model = '', effort] = part.split(':')
    if (!model) throw new Error(`${part}: expected <provider>:<model>[:<effort>]`)
    return { provider: providerOf(provider), model, ...(effort ? { effort } : {}) }
  })
}

export async function setConsent(
  db: Db,
  provider: ProviderName,
  input:
    | 'off'
    | {
        by: string
        types: string[]
        stages: string[]
        frames: boolean
        privacy: string
        prices: Consent['prices']
      },
) {
  if (input === 'off') return writeAnnotationSetting(db, annotationKey.consent(provider), null)
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)
  const consent = valid(
    ConsentSchema,
    {
      by: input.by,
      at: new Date(rows[0]?.now ?? Date.now()).toISOString(),
      types: input.types.map(typeOf),
      stages: input.stages.map(stageOf),
      frames: input.frames,
      privacy: input.privacy,
      prices: input.prices,
    },
    `consent ${provider}`,
  )
  return writeAnnotationSetting(db, annotationKey.consent(provider), consent)
}

/** A new window of the budget from now (the database's clock: the runs count by it). */
export async function setBudget(db: Db, usd: number | 'off') {
  if (usd === 'off') return writeAnnotationSetting(db, annotationKey.budget, null)
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)
  return writeAnnotationSetting(db, annotationKey.budget, {
    usd,
    since: new Date(rows[0]?.now ?? Date.now()).toISOString(),
  })
}

export async function setRoute(
  db: Db,
  type: string,
  stage: string,
  input: 'off' | { providers: string; fields?: string; frames?: number; maxUsd?: number },
  modelCode?: string,
) {
  const key = annotationKey.route(typeOf(type), stageOf(stage))
  if (input === 'off') return writeAnnotationSetting(db, key, null, modelCode)
  const fields = list(input.fields)
  for (const field of fields) {
    if (!(AGGREGATE_FIELDS as readonly string[]).includes(field)) {
      throw new Error(`${field}: a field is one of ${AGGREGATE_FIELDS.join(', ')}`)
    }
  }
  const route = valid(
    RouteSchema,
    {
      providers: routeProvidersOf(input.providers),
      ...(fields.length > 0 ? { fields } : {}),
      ...(input.frames ? { frames: input.frames } : {}),
      ...(input.maxUsd ? { max_usd: input.maxUsd } : {}),
    },
    key,
  )
  return writeAnnotationSetting(db, key, route, modelCode)
}

interface WorkCount extends Record<string, unknown> {
  dataset: string | null
  state: string
  paused_reason: string | null
  n: number
}

/** Everything in force, without the values of the keys: «есть» or «нет» for each. */
export async function annotationStatus(
  db: Db,
  modelCode: string,
  env: Record<string, string | undefined>,
) {
  const modelId = await modelIdOf(db, modelCode)
  const settings: AnnotationSettings = await annotationSettings(db, modelId)
  const spent = settings.budget
    ? await Promise.all(
        PROVIDERS.map(async (provider) => [
          provider,
          await spentSince(db, settings.budget?.since ?? '', provider, ''),
        ]),
      )
    : []
  const stops: Record<string, unknown> = {}
  for (const provider of PROVIDERS) {
    const resumed = settings.resumed.get(provider) ?? null
    const byType: Record<string, unknown> = {}
    for (const type of MARKUP_TYPES) {
      const stop = await providerStop(db, provider, type, resumed)
      if (stop) byType[type] = stop
    }
    if (Object.keys(byType).length > 0) stops[provider] = byType
  }
  const { rows: works } = await db.execute<WorkCount>(sql`
    SELECT dataset, state, paused_reason, count(*)::int AS n FROM work_operations
     WHERE kind = 'annotate' AND model_id = ${modelId}::uuid
       AND (state IN ('pending', 'running', 'retry_wait') OR finished_at > now() - interval '7 days')
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)
  return {
    model: modelCode,
    keys: {
      openai: env.OPENAI_API_KEY ? 'есть' : 'нет',
      anthropic: env.ANTHROPIC_API_KEY ? 'есть' : 'нет',
    },
    enabled: settings.enabled,
    texts: settings.texts,
    budget: settings.budget
      ? {
          ...settings.budget,
          spent_usd: Number(
            (spent[0]?.[1] as { total: number } | undefined)?.total.toFixed(6) ?? 0,
          ),
          by_provider: Object.fromEntries(
            spent.map(([provider, s]) => [
              provider as string,
              (s as { provider: number }).provider,
            ]),
          ),
        }
      : null,
    consents: Object.fromEntries(
      [...settings.consents].map(([provider, consent]) => [
        provider,
        {
          ...consent,
          priced_models: [
            ...new Set([...Object.keys(KNOWN_PRICES[provider]), ...Object.keys(consent.prices)]),
          ],
        },
      ]),
    ),
    limits: Object.fromEntries(settings.limits),
    routes: Object.fromEntries(settings.routes),
    resumed: Object.fromEntries(settings.resumed),
    stops,
    works,
  }
}

interface ItemRow extends Record<string, unknown> {
  id: string
  type: string
  number: number
}

/** Objects by their IDs, or the newest `limit` of a type that have no run by routes yet. */
async function itemsOf(
  db: Db,
  modelId: string,
  input: { ids?: readonly string[]; type?: string; limit?: number },
): Promise<ItemRow[]> {
  if (input.ids && input.ids.length > 0) {
    const out: ItemRow[] = []
    for (const id of input.ids) {
      const parsed = parseItemId(id)
      if (!parsed) throw new Error(`${id}: not an object ID (PPV-073)`)
      const { rows } = await db.execute<ItemRow>(sql`
        SELECT id, type, number FROM content_items
         WHERE model_id = ${modelId}::uuid AND type = ${ITEM_TYPE_INFO[parsed.type].prefix}
           AND number = ${parsed.number} AND deleted_at IS NULL`)
      if (!rows[0]) throw new Error(`${id}: no such object of the model`)
      out.push(rows[0])
    }
    return out
  }
  if (!input.type) throw new Error('name the objects (PPV-073 …) or --type with --limit')
  const { rows } = await db.execute<ItemRow>(sql`
    SELECT i.id, i.type, i.number FROM content_items i
     WHERE i.model_id = ${modelId}::uuid AND i.type = ${typeOf(input.type)} AND i.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM annotation_runs r
                        WHERE r.model_id = i.model_id AND r.item_id = i.id AND NOT r.probe)
     ORDER BY i.created_at DESC
     LIMIT ${input.limit ?? 10}`)
  return rows
}

const publicId = (row: Pick<ItemRow, 'type' | 'number'>) =>
  `${row.type}-${String(row.number).padStart(row.type === 'FYP' || row.type === 'RAW' ? 4 : 3, '0')}`

/** The markup by routes of the objects named (or a tranche of a type), as works of `worker`. */
export async function runRoutine(
  db: Db,
  input: { model: string; ids?: string[]; type?: string; limit?: number; pass?: string },
): Promise<{ item: string; queued: Queued }[]> {
  const modelId = await modelIdOf(db, input.model)
  const pass = input.pass ?? new Date().toISOString().slice(0, 10)
  const out: { item: string; queued: Queued }[] = []
  for (const item of await itemsOf(db, modelId, input)) {
    out.push({
      item: publicId(item),
      queued: await enqueueAnnotation(db, { modelId, itemId: item.id, pass }),
    })
  }
  return out
}

/**
 * The measurement of PLAN 8а on the objects named: one provider and model, the stages asked
 * (all the type has by default), its answers never reach the fields.
 */
export async function runProbe(
  db: Db,
  input: {
    model: string
    ids: string[]
    with: string
    stages?: string
    frames?: number
    pass?: string
  },
): Promise<{ item: string; queued: Queued }[]> {
  const modelId = await modelIdOf(db, input.model)
  const [choice] = routeProvidersOf(input.with)
  if (!choice) throw new Error('--with <provider>:<model>[:<effort>]')
  const asked = list(input.stages).map(stageOf)
  const pass = input.pass ?? new Date().toISOString().slice(0, 10)
  const out: { item: string; queued: Queued }[] = []
  for (const item of await itemsOf(db, modelId, { ids: input.ids })) {
    const stages = asked.length > 0 ? asked : stagesOf(item.type as MarkupType)
    out.push({
      item: publicId(item),
      queued: await enqueueProbe(db, {
        modelId,
        itemId: item.id,
        stages,
        probe: { ...choice, ...(input.frames ? { frames: input.frames } : {}) },
        pass,
      }),
    })
  }
  return out
}

interface ReportRun extends Record<string, unknown> {
  item_id: string
  type: string
  number: number
  title: string | null
  title_en: string | null
  description: string | null
  /** Fields a person confirmed: the manager's reference of the measurement. */
  confirmed: string[] | null
  stage: Stage
  provider: string
  model_name: string
  state: string
  attempt: number
  frames_count: number
  cost_usd: number | null
  tokens: { input_tokens?: number; output_tokens?: number } | null
  refusal_reason: string | null
  error_code: string | null
  finished_at: string | null
  suggestions: { field: string; value: unknown; refusal_reason: string | null }[] | null
}

const cell = (text: string | null | undefined) =>
  (text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

function valueWords(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (field === 'chronology' && Array.isArray(value)) {
    return value
      .map((segment: { at_ms?: number; text?: string }) => {
        const s = Math.round((segment.at_ms ?? 0) / 1000)
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} ${segment.text ?? ''}`
      })
      .join('; ')
  }
  if (field === 'observations' && typeof value === 'object') {
    const observations = (value as { observations?: { n: number; facts: string[] }[] }).observations
    return (observations ?? []).map((item) => `${item.n}: ${item.facts.join(', ')}`).join(' · ')
  }
  if (field === 'platform_texts' && typeof value === 'object') {
    const texts = value as { wall?: string; message?: string }
    return `стена: ${texts.wall ?? '—'} / личка: ${texts.message ?? '—'}`
  }
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/**
 * The runs of a model as Markdown: the table of requests (stage, provider, outcome, frames,
 * price, tokens, the reason of a refusal), then each object — the manager's confirmed fields
 * (the reference of the measurement) next to what each provider wrote. Real content: never into
 * git, the summary goes to `docs/reference/annotation.md` in words.
 */
export async function annotationReport(
  db: Db,
  input: { model: string; probe: boolean; since?: string },
): Promise<string> {
  const modelId = await modelIdOf(db, input.model)
  const since = input.since ?? '2000-01-01'
  const { rows } = await db.execute<ReportRun>(sql`
    SELECT r.item_id, i.type, i.number, i.title, i.title_en, i.description,
           (SELECT array_agg(f.field ORDER BY f.field) FROM annotation_fields f
             WHERE f.model_id = i.model_id AND f.item_id = i.id
               AND f.confirmed_value_version = f.value_version) AS confirmed,
           r.stage, r.provider,
           r.model_name, r.state, r.attempt, r.frames_count, r.cost_usd::float8 AS cost_usd,
           r.tokens, r.refusal_reason, r.error_code, r.finished_at::text AS finished_at,
           (SELECT jsonb_agg(jsonb_build_object('field', s.field, 'value', s.value,
                                                'refusal_reason', s.refusal_reason)
                             ORDER BY s.field)
              FROM annotation_suggestions s
             WHERE s.model_id = r.model_id AND s.run_id = r.id) AS suggestions
      FROM annotation_runs r
      JOIN content_items i ON i.model_id = r.model_id AND i.id = r.item_id
     WHERE r.model_id = ${modelId}::uuid AND r.probe = ${input.probe}
       AND r.created_at >= ${since}::timestamptz
     ORDER BY i.type, i.number, r.created_at, r.attempt`)
  const lines: string[] = [
    `# Разметка ИИ: ${input.probe ? 'замер' : 'по маршрутам'} · ${input.model}`,
    '',
    `Запусков: ${rows.length}. Только для владельца: внутри — то, что модели написали о настоящем контенте, в git не класть.`,
    '',
  ]
  const totals = new Map<
    string,
    { runs: number; refused: number; usd: number; items: Set<string> }
  >()
  for (const row of rows) {
    const key = `${row.provider} ${row.model_name} · ${row.type}`
    const total = totals.get(key) ?? { runs: 0, refused: 0, usd: 0, items: new Set() }
    total.runs += 1
    total.usd += row.cost_usd ?? 0
    if (row.state === 'refused') total.refused += 1
    total.items.add(row.item_id)
    totals.set(key, total)
  }
  lines.push('| Поставщик · тип | Объектов | Запросов | Отказов | Цена |', '|---|---|---|---|---|')
  for (const [key, total] of totals) {
    lines.push(
      `| ${key} | ${total.items.size} | ${total.runs} | ${total.refused} (${Math.round((total.refused / Math.max(1, total.runs)) * 100)} %) | $${total.usd.toFixed(4)} |`,
    )
  }
  lines.push(
    '',
    '| Объект | Стадия | Поставщик | Модель | Итог | Кадров | Цена | Токены вх/вых | Причина |',
    '|---|---|---|---|---|---|---|---|---|',
  )
  for (const row of rows) {
    lines.push(
      `| ${publicId(row)} | ${row.stage} | ${row.provider} | ${cell(row.model_name)} | ${row.state}${row.attempt > 1 ? ` (попытка ${row.attempt})` : ''} | ${row.frames_count} | ${row.cost_usd === null ? '—' : `$${row.cost_usd.toFixed(4)}`} | ${row.tokens?.input_tokens ?? '—'}/${row.tokens?.output_tokens ?? '—'} | ${cell(row.refusal_reason ?? row.error_code)} |`,
    )
  }
  const byItem = new Map<string, ReportRun[]>()
  for (const row of rows) byItem.set(row.item_id, [...(byItem.get(row.item_id) ?? []), row])
  for (const runs of byItem.values()) {
    const first = runs[0]
    if (!first) continue
    lines.push('', `## ${publicId(first)}`, '')
    const mark = (field: string) =>
      (first.confirmed ?? []).includes(field) ? ' (подтверждено — эталон КМ)' : ' (черновик)'
    lines.push(
      `- В карточке: название «${first.title ?? '—'}»${mark('title')}, англ. «${first.title_en ?? '—'}»${mark('title_en')}; описание${mark('description')}: ${cell(first.description)}`,
    )
    for (const run of runs) {
      for (const suggestion of run.suggestions ?? []) {
        if (suggestion.field === 'facts' && !suggestion.value) continue
        lines.push(
          `- ${run.provider} ${run.model_name} · ${run.stage} · ${suggestion.field}: ${suggestion.refusal_reason ? `отказ — ${cell(suggestion.refusal_reason)}` : cell(valueWords(suggestion.field, suggestion.value))}`,
        )
      }
    }
  }
  return `${lines.join('\n')}\n`
}

export interface AnnotationCliOptions {
  model?: string | undefined
  type?: string | undefined
  types?: string | undefined
  stages?: string | undefined
  privacy?: string | undefined
  price?: string[] | undefined
  'no-frames'?: boolean | undefined
  by?: string | undefined
  fields?: string | undefined
  frames?: string | undefined
  'max-usd'?: string | undefined
  with?: string | undefined
  pass?: string | undefined
  limit?: string | undefined
  probe?: boolean | undefined
  since?: string | undefined
}

export const ANNOTATION_USAGE = `  ops.js annotation status --model <m>
  ops.js annotation consent <provider> --types PPV,CUS --stages observe,aggregate,texts --privacy "<storage setting>" [--no-frames] [--price <model>=<in>/<out>] [--by <name>]
  ops.js annotation consent <provider> off
  ops.js annotation budget <usd>|off       (a new window from now)
  ops.js annotation limit <provider> <usd>|off
  ops.js annotation route <TYPE> <stage> <provider>:<model>[:<effort>][,<spare>:<model>] [--fields title,tags] [--frames 48] [--max-usd 10] [--model <m>]
  ops.js annotation route <TYPE> <stage> off [--model <m>]
  ops.js annotation on|off [--model <m>]   (the markup by routes)
  ops.js annotation texts on|off [--model <m>]
  ops.js annotation resume <provider>      (after a refused key or the breaker)
  ops.js annotation run <model> [<ID> …] [--type FYP --limit 50] [--pass <tag>]
  ops.js annotation probe <model> <ID> … --with <provider>:<model>[:<effort>] [--stages observe,aggregate] [--frames 48] [--pass <tag>]
  ops.js annotation report <model> [--probe] [--since YYYY-MM-DD]   (Markdown, out of git)`

const positive = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name}: a positive number`)
  return number
}

/** `ops.js annotation <command> …`: JSON on stdout, the report as Markdown. */
export async function annotationCli(
  db: Db,
  args: readonly string[],
  options: AnnotationCliOptions,
  env: Record<string, string | undefined>,
): Promise<{ json?: unknown; text?: string }> {
  const [command, first, second, third] = args
  switch (command) {
    case 'status': {
      if (!options.model) throw new Error('status --model <m>')
      return { json: await annotationStatus(db, options.model, env) }
    }
    case 'consent': {
      if (!first) throw new Error(ANNOTATION_USAGE)
      const provider = providerOf(first)
      if (second === 'off') return { json: await setConsent(db, provider, 'off') }
      if (!options.types || !options.stages || !options.privacy) {
        throw new Error('consent needs --types, --stages and --privacy')
      }
      return {
        json: await setConsent(db, provider, {
          by: options.by ?? 'владелец',
          types: list(options.types),
          stages: list(options.stages),
          frames: options['no-frames'] !== true,
          privacy: options.privacy,
          prices: pricesOf(options.price ?? []),
        }),
      }
    }
    case 'budget': {
      if (!first) throw new Error(ANNOTATION_USAGE)
      return { json: await setBudget(db, first === 'off' ? 'off' : (positive(first, 'usd') ?? 0)) }
    }
    case 'limit': {
      if (!first || !second) throw new Error(ANNOTATION_USAGE)
      const key = annotationKey.limit(providerOf(first))
      return {
        json: await writeAnnotationSetting(
          db,
          key,
          second === 'off' ? null : { usd: positive(second, 'usd') },
        ),
      }
    }
    case 'route': {
      if (!first || !second || !third) throw new Error(ANNOTATION_USAGE)
      if (third === 'off') return { json: await setRoute(db, first, second, 'off', options.model) }
      const frames = positive(options.frames, '--frames')
      const maxUsd = positive(options['max-usd'], '--max-usd')
      return {
        json: await setRoute(
          db,
          first,
          second,
          {
            providers: third,
            ...(options.fields ? { fields: options.fields } : {}),
            ...(frames ? { frames } : {}),
            ...(maxUsd ? { maxUsd } : {}),
          },
          options.model,
        ),
      }
    }
    case 'on':
    case 'off':
      return {
        json: await writeAnnotationSetting(
          db,
          annotationKey.enabled,
          command === 'on',
          options.model,
        ),
      }
    case 'texts': {
      if (first !== 'on' && first !== 'off') throw new Error('texts on|off')
      return {
        json: await writeAnnotationSetting(db, annotationKey.texts, first === 'on', options.model),
      }
    }
    case 'resume': {
      if (!first) throw new Error(ANNOTATION_USAGE)
      const { rows } = await db.execute<{ now: string }>(sql`SELECT now()::text AS now`)
      return {
        json: await writeAnnotationSetting(db, annotationKey.resumed(providerOf(first)), {
          at: new Date(rows[0]?.now ?? Date.now()).toISOString(),
        }),
      }
    }
    case 'run': {
      if (!first) throw new Error(ANNOTATION_USAGE)
      const limit = positive(options.limit, '--limit')
      return {
        json: await runRoutine(db, {
          model: first,
          ids: args.slice(2),
          ...(options.type ? { type: options.type } : {}),
          ...(limit ? { limit } : {}),
          ...(options.pass ? { pass: options.pass } : {}),
        }),
      }
    }
    case 'probe': {
      if (!first || !options.with || args.length < 3) throw new Error(ANNOTATION_USAGE)
      const frames = positive(options.frames, '--frames')
      return {
        json: await runProbe(db, {
          model: first,
          ids: args.slice(2),
          with: options.with,
          ...(options.stages ? { stages: options.stages } : {}),
          ...(frames ? { frames } : {}),
          ...(options.pass ? { pass: options.pass } : {}),
        }),
      }
    }
    case 'report': {
      if (!first) throw new Error(ANNOTATION_USAGE)
      return {
        text: await annotationReport(db, {
          model: first,
          probe: options.probe === true,
          ...(options.since ? { since: options.since } : {}),
        }),
      }
    }
    default:
      throw new Error(ANNOTATION_USAGE)
  }
}
