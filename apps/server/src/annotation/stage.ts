import { createHash, randomUUID } from 'node:crypto'
import {
  type Db,
  SYSTEM_ACTOR,
  type Tx,
  type values,
  WorkDeferred,
  WorkError,
  WorkPaused,
  withActorTx,
} from '@contentops/db'
import {
  AGGREGATE_FIELDS,
  type AggregateField,
  type AggregateOutput,
  KNOWN_PRICES,
  type Observation,
  type ObserveOutput,
  PROMPT_VERSION,
  type Price,
  reserveOf,
  type Sent,
  type Stage,
  type TextsOutput,
  type Usage,
  usdOf,
  VisionError,
  type VisionInput,
  type VisionResult,
} from '@contentops/vision'
import { sql } from 'drizzle-orm'
import type { BlobStore } from '../media/storage'
import {
  applySuggestions,
  type FieldVersions,
  fieldVersions,
  type SuggestedValues,
  tagSlug,
} from './apply'
import { logHeldBack, logReceipt, type ReceiptOutcome } from './journal'
import { reserve } from './money'
import type { ProviderRegistry } from './providers'
import { aggregateInput, observeInput, textsInput, verifiedObservations } from './serialize'
import {
  type AnnotationSettings,
  annotationKey,
  type Consent,
  DEFAULT_FRAMES,
  type Route,
  type RouteProvider,
} from './settings'
import { providerStop } from './stops'
import { type AnnotationSubject, frameBytes, type Privacy, pickEvenly } from './subject'

/**
 * One stage of the markup of one object (SPEC §8.3): its route — a provider and at most one
 * independent spare, then the manager — the owner's consent, the key, the stops, the reserve
 * before the send, the request, the receipt, the suggestions and their way into the fields.
 *
 * A refusal (the policy's error or a refusal in a successful answer) is a normal outcome: the
 * run ends «refused», the fields stay drafts with the reason, the same input never goes to the
 * same provider again. Whatever the area of a stage has off — a route, a consent, the budget, a
 * key, a stopped provider — the work waits with that key (`WorkPaused`) and goes on when the
 * owner turns it on; what a policy keeps back from a provider is not sent at all.
 */

/** Output allowance of each stage: thinking of the model included. */
const MAX_OUTPUT: Record<Stage, number> = { observe: 8_000, aggregate: 6_000, texts: 3_000 }

export const DEFAULT_TIMEOUT_MS = 240_000

export interface ProbeChoice extends RouteProvider {
  frames?: number
}

export interface ChainContext {
  db: Db
  store: BlobStore
  providers: ProviderRegistry
  settings: AnnotationSettings
  subject: AnnotationSubject
  workId: string | null
  signal?: AbortSignal
  timeoutMs: number
  /** The measurement: the provider and model the owner chose; never applied to the fields. */
  probe: ProbeChoice | null
  /** The stages of this chain, in order: a refusal fails the fields of the later ones too. */
  stages: readonly Stage[]
}

export type StageOutcome =
  | { kind: 'answered'; stage: Stage; runId: string; state: 'succeeded' | 'partial' }
  | { kind: 'refused'; stage: Stage; runIds: string[] }
  | { kind: 'held'; stage: Stage; reason: string }
  | { kind: 'skipped'; stage: Stage; reason: string }

/** A frame of the request: its number, second, moment and stored artifact. */
interface FrameRef {
  n: number
  t_s: number | null
  ms: number | null
  artifact: string
}

interface Prepared {
  input: VisionInput
  frames: FrameRef[]
  withheld: number
  parentRunId: string | null
  /** The fields the stage writes (for `aggregate` — those its route asks). */
  fields: string[]
}

const ACTOR = SYSTEM_ACTOR('annotation')

function context(action: string, workId: string | null, itemId: string) {
  return { actor: ACTOR, action, requestId: `annotation:${randomUUID()}`, workId, itemId }
}

/** Fields the later stages of the chain would write: they fail with a refusal of this one. */
function downstream(ctx: ChainContext, stage: Stage): string[] {
  const later = ctx.stages.slice(ctx.stages.indexOf(stage) + 1)
  const fields: string[] = []
  for (const next of later) {
    if (next === 'aggregate') {
      const own = ctx.settings.routes.get(`${ctx.subject.type}.aggregate`)
      fields.push(
        ...(own?.fields ?? AGGREGATE_FIELDS).filter(
          (f) => f !== 'chronology' || ctx.subject.hasVideo,
        ),
      )
    }
    if (next === 'texts' && ctx.subject.type === 'PPV') fields.push('platform_texts')
  }
  return fields
}

/** Why the consent keeps this request back, or `null` when it lets it go. */
function consentHolds(consent: Consent, ctx: ChainContext, stage: Stage): string | null {
  if (!consent.types.includes(ctx.subject.type)) {
    return `согласие на ${ctx.subject.type} не дано`
  }
  if (!consent.stages.includes(stage)) return `согласие на стадию ${stage} не дано`
  if (stage === 'observe' && !consent.frames) return 'согласие не включает кадры'
  return null
}

interface ParentRow extends Record<string, unknown> {
  id: string
  value: unknown
  tags: unknown
}

/**
 * The latest answered run of the previous stage over the same media; a measurement prefers the
 * one of its own provider and model, but may go on from another (frames by one, texts by another).
 */
async function parentOf(
  ctx: ChainContext,
  stage: 'observe' | 'aggregate',
  field: 'observations' | 'facts',
): Promise<ParentRow | null> {
  const { subject, probe } = ctx
  const { rows } = await ctx.db.execute<ParentRow>(sql`
    SELECT r.id, s.value,
           (SELECT t.value FROM annotation_suggestions t
             WHERE t.model_id = r.model_id AND t.run_id = r.id AND t.field = 'tags') AS tags
      FROM annotation_runs r
      JOIN annotation_suggestions s ON s.model_id = r.model_id AND s.run_id = r.id
                                   AND s.field = ${field} AND s.value IS NOT NULL
     WHERE r.model_id = ${subject.modelId}::uuid AND r.item_id = ${subject.itemId}::uuid
       AND r.input_sha256 = ${subject.inputSha256} AND r.stage = ${stage}
       AND r.probe = ${probe !== null} AND r.state IN ('succeeded', 'partial')
     ORDER BY ${probe ? sql`(r.provider = ${probe.provider} AND r.model_name = ${probe.model}) DESC,` : sql``}
              r.finished_at DESC
     LIMIT 1`)
  return rows[0] ?? null
}

async function prepare(
  ctx: ChainContext,
  stage: Stage,
  route: Route | null,
): Promise<Prepared | { skipped: string }> {
  const { subject } = ctx
  if (stage === 'observe') {
    const limit = ctx.probe?.frames ?? route?.frames ?? DEFAULT_FRAMES
    const chosen = pickEvenly(subject.frames, limit)
    const loaded: { frameMs: number | null; data: Buffer; artifact: string }[] = []
    let withheld = 0
    for (const frame of chosen) {
      const data = await frameBytes(ctx.store, frame.storageKey)
      if (data) loaded.push({ frameMs: frame.frameMs, data, artifact: frame.artifactId })
      else withheld += 1
    }
    if (loaded.length === 0) {
      return { skipped: withheld > 0 ? 'кадры не читаются' : 'у объекта нет сохранённых кадров' }
    }
    const input = observeInput(subject, loaded)
    return {
      input,
      frames: input.frames.map((frame, index) => ({
        n: frame.n,
        t_s: frame.t_s,
        ms: loaded[index]?.frameMs ?? null,
        artifact: loaded[index]?.artifact ?? '',
      })),
      withheld,
      parentRunId: null,
      fields: ['observations'],
    }
  }
  if (stage === 'aggregate') {
    const parent = await parentOf(ctx, 'observe', 'observations')
    const seen = parent?.value as { frames?: FrameRef[]; observations?: Observation[] } | undefined
    const frames = seen?.frames ?? []
    const observations = verifiedObservations(
      seen?.observations ?? [],
      frames.length,
      subject.privacy,
    )
    if (!parent || observations.length === 0) return { skipped: 'нет наблюдений по кадрам' }
    const asked = ctx.probe ? [...AGGREGATE_FIELDS] : (route?.fields ?? [...AGGREGATE_FIELDS])
    const input = aggregateInput(subject, { frames, observations }, asked as AggregateField[])
    return {
      input,
      frames,
      withheld: 0,
      parentRunId: parent.id,
      fields: [...(input.stage === 'aggregate' ? input.fields : []), 'facts'],
    }
  }
  if (subject.type !== 'PPV') return { skipped: 'тексты для платформы — только у PPV' }
  const parent = await parentOf(ctx, 'aggregate', 'facts')
  const facts = typeof parent?.value === 'string' ? parent.value : null
  if (!parent || !facts) return { skipped: 'нет сводки фактов' }
  const tags = [
    ...new Set([
      ...(Array.isArray(parent.tags) ? (parent.tags as string[]) : []),
      ...subject.dictionaryTags,
    ]),
  ]
  return {
    input: textsInput(subject, facts, tags),
    frames: [],
    withheld: 0,
    parentRunId: parent.id,
    fields: ['platform_texts'],
  }
}

/** The input as it is digested: everything that goes out, the pictures by their artifacts. */
function digestOf(parts: Record<string, unknown>, prepared: Prepared): string {
  const { input } = prepared
  const shape =
    input.stage === 'observe'
      ? { ...input, frames: input.frames.map((frame) => ({ n: frame.n, t_s: frame.t_s })) }
      : input
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        ...parts,
        parent: prepared.parentRunId,
        frames: prepared.frames.map((frame) => frame.artifact),
        input: shape,
      }),
    )
    .digest('hex')
}

interface RunRow extends Record<string, unknown> {
  id: string
  attempt: number
  state: values.AnnotationRunState
  error_code: string | null
  outcome_unknown: boolean
  reserved_usd: number | null
  work_id: string | null
}

const cents = (usd: number) => Math.round(usd * 1e6) / 1e6

async function stillRunning(db: Db, workId: string): Promise<boolean> {
  const { rows } = await db.execute<{ running: boolean }>(sql`
    SELECT state = 'running' AND lease_until > now() AS running FROM work_operations
     WHERE id = ${workId}::uuid`)
  return rows[0]?.running === true
}

/** Runs one stage with the route's provider and, after its refusal, the spare. */
export async function runStage(ctx: ChainContext, stage: Stage): Promise<StageOutcome> {
  const { subject, settings } = ctx
  let route: Route | null = null
  let candidates: RouteProvider[]
  if (ctx.probe) {
    candidates = [ctx.probe]
  } else {
    route = settings.routes.get(`${subject.type}.${stage}`) ?? null
    if (!route) throw new WorkPaused(annotationKey.route(subject.type, stage))
    if (stage === 'texts' && !settings.texts) throw new WorkPaused(annotationKey.texts)
    candidates = route.providers
  }
  const prepared = await prepare(ctx, stage, route)
  if ('skipped' in prepared) return { kind: 'skipped', stage, reason: prepared.skipped }
  const refused: string[] = []
  const held: string[] = []
  for (const [position, choice] of candidates.entries()) {
    const outcome = await tryProvider(ctx, stage, route, prepared, choice, position)
    if (outcome.kind === 'answered') return outcome
    if (outcome.kind === 'refused') refused.push(...outcome.runIds)
    if (outcome.kind === 'held') held.push(outcome.reason)
  }
  if (refused.length > 0) return { kind: 'refused', stage, runIds: refused }
  return { kind: 'held', stage, reason: held.join('; ') }
}

async function tryProvider(
  ctx: ChainContext,
  stage: Stage,
  route: Route | null,
  prepared: Prepared,
  choice: RouteProvider,
  position: number,
): Promise<StageOutcome> {
  const { db, subject, settings } = ctx
  const provider = choice.provider
  const routeName = ctx.probe ? 'probe' : `${subject.type}.${stage}`
  const consent = settings.consents.get(provider)
  if (!consent) throw new WorkPaused(annotationKey.consent(provider))
  const hold = async (reason: string): Promise<StageOutcome> => {
    await withActorTx(db, context('annotation.held', ctx.workId, subject.itemId), (tx) =>
      logHeldBack(tx, {
        modelId: subject.modelId,
        itemId: subject.itemId,
        publicId: subject.publicId,
        stage,
        provider,
        model: choice.model,
        reason,
        workId: ctx.workId,
      }),
    )
    return { kind: 'held', stage, reason }
  }
  const policy = consentHolds(consent, ctx, stage)
  if (policy) return hold(policy)
  const adapter = ctx.providers(provider)
  if (!adapter) throw new WorkPaused(annotationKey.key(provider))
  const stop = await providerStop(
    db,
    provider,
    subject.type,
    settings.resumed.get(provider) ?? null,
  )
  // A measurement goes on past the breaker (it measures refusals), never past a refused key.
  if (stop && !(ctx.probe && stop.kind === 'breaker')) {
    throw new WorkPaused(annotationKey.resumed(provider))
  }
  const price: Price | undefined =
    consent.prices[choice.model] ?? KNOWN_PRICES[provider][choice.model]
  if (!price) return hold(`нет цены модели ${choice.model}`)
  const budget = settings.budget
  if (!budget) throw new WorkPaused(annotationKey.budget)
  const maxOutput = MAX_OUTPUT[stage]
  const configDigest = digestOf(
    {
      stage,
      provider,
      model: choice.model,
      effort: choice.effort ?? null,
      prompt: PROMPT_VERSION[stage],
      probe: ctx.probe !== null,
      route: routeName,
      max_output: maxOutput,
    },
    prepared,
  )
  const { rows: earlier } = await db.execute<RunRow>(sql`
    SELECT id, attempt, state, error_code, outcome_unknown, reserved_usd::float8 AS reserved_usd,
           work_id
      FROM annotation_runs
     WHERE model_id = ${subject.modelId}::uuid AND item_id = ${subject.itemId}::uuid
       AND input_sha256 = ${subject.inputSha256} AND config_digest = ${configDigest}
     ORDER BY attempt DESC LIMIT 1`)
  const last = earlier[0]
  if (last) {
    if (last.state === 'succeeded' || last.state === 'partial') {
      return { kind: 'answered', stage, runId: last.id, state: last.state }
    }
    if (last.state === 'refused') return { kind: 'refused', stage, runIds: [last.id] }
    if (last.state === 'running') {
      if (last.work_id && last.work_id !== ctx.workId && (await stillRunning(db, last.work_id))) {
        throw new WorkDeferred(60_000, 'этот же запрос идёт в другой работе')
      }
      // Left by a worker that stopped mid-request: it may have been done and paid.
      await settleUnknown(ctx, stage, choice, last, routeName, configDigest, prepared)
      throw new WorkError('permanent', 'outcome_unknown', 'исход запроса неизвестен')
    }
    if (last.outcome_unknown) {
      throw new WorkError('permanent', 'outcome_unknown', 'исход запроса неизвестен')
    }
    if (last.error_code === 'bad_request' || last.error_code === 'bad_response') {
      throw new WorkError(
        'permanent',
        last.error_code,
        'поставщик не принял запрос или ответ не разобран',
      )
    }
  }
  const attempt = (last?.attempt ?? 0) + 1
  const amount = reserveOf(provider, prepared.input, maxOutput, price)
  const seen: FieldVersions = ctx.probe
    ? {}
    : await fieldVersions(db, subject.modelId, subject.itemId, subject.versionId)
  const reserved = await withActorTx(
    db,
    context('annotation.reserve', ctx.workId, subject.itemId),
    async (tx) => {
      const fits = await reserve(tx, {
        budget,
        provider,
        providerLimit: settings.limits.get(provider) ?? null,
        route: routeName,
        routeKey: ctx.probe ? null : annotationKey.route(subject.type, stage),
        routeLimit: route?.max_usd ?? null,
        amount,
      })
      if (!fits.ok) return fits
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO annotation_runs (
          model_id, item_id, version_id, stage, parent_run_id, attempt, route_position, probe,
          route, provider, model_name, prompt_version, input_sha256, config_digest, params,
          frames_count, withheld_count, billing_scope, state, reserved_usd, sent_at, work_id
        ) VALUES (
          ${subject.modelId}::uuid, ${subject.itemId}::uuid, ${subject.versionId}::uuid, ${stage},
          ${prepared.parentRunId}::uuid, ${attempt}, ${position}, ${ctx.probe !== null},
          ${routeName}, ${provider}, ${choice.model}, ${PROMPT_VERSION[stage]},
          ${subject.inputSha256}, ${configDigest},
          ${JSON.stringify({ frames: prepared.frames, fields: prepared.fields, seen, effort: choice.effort ?? null })}::jsonb,
          ${prepared.frames.length}, ${prepared.withheld}, ${provider}, 'running', ${amount}, now(),
          ${ctx.workId}::uuid
        )
        RETURNING id`)
      const id = rows[0]?.id
      if (!id) throw new Error('annotation run was not inserted')
      return { ok: true as const, id }
    },
  )
  if (!reserved.ok) throw new WorkPaused(reserved.key, reserved.reason)

  const wire: { sent: Sent | null } = { sent: null }
  const call = {
    model: choice.model,
    effort: choice.effort ?? null,
    maxOutputTokens: maxOutput,
    timeoutMs: ctx.timeoutMs,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    onSent: (bytes: Sent) => {
      wire.sent = bytes
    },
  }
  let result: VisionResult<unknown>
  try {
    const input = prepared.input
    result =
      input.stage === 'observe'
        ? await adapter.observe(input, call)
        : input.stage === 'aggregate'
          ? await adapter.compose(input, call)
          : await adapter.compose(input, call)
  } catch (error) {
    const failure =
      error instanceof VisionError
        ? error
        : new VisionError(wire.sent ? 'unknown_outcome' : 'transient', String(error), {
            cause: error,
          })
    await settleFailure(
      ctx,
      stage,
      choice,
      reserved.id,
      attempt,
      amount,
      price,
      routeName,
      configDigest,
      prepared,
      failure,
      wire.sent,
    )
    switch (failure.kind) {
      case 'auth_rejected':
        throw new WorkPaused(annotationKey.resumed(provider), failure.message)
      case 'rate_limited':
      case 'transient':
        throw new WorkError('transient', failure.kind, failure.message, {
          ...(failure.retryAfterMs !== null ? { retryAfterMs: failure.retryAfterMs } : {}),
        })
      case 'unknown_outcome':
        throw new WorkError('permanent', 'outcome_unknown', failure.message)
      default:
        throw new WorkError('permanent', failure.kind, failure.message)
    }
  }
  return settleAnswer(
    ctx,
    stage,
    choice,
    reserved.id,
    attempt,
    price,
    routeName,
    configDigest,
    prepared,
    result,
    wire.sent,
    seen,
  )
}

interface Built {
  values: Map<string, unknown>
  refusals: Map<string, string>
  apply: SuggestedValues
}

function reasonOf(declined: { field: string; reason: string }[], field: string): string {
  return declined.find((item) => item.field === field)?.reason?.trim() || 'нет значения в ответе'
}

/** The answer as suggestions: a value for each field, or the reason it has none. */
function build(stage: Stage, output: unknown, prepared: Prepared, privacy: Privacy): Built {
  const built: Built = { values: new Map(), refusals: new Map(), apply: {} }
  if (stage === 'observe') {
    const observations = verifiedObservations(
      (output as ObserveOutput).observations,
      prepared.frames.length,
      privacy,
    )
    if (observations.length > 0) {
      built.values.set('observations', { frames: prepared.frames, observations })
    } else {
      built.refusals.set('observations', 'в ответе нет ни одного наблюдения')
    }
    return built
  }
  if (stage === 'aggregate') {
    const answer = output as AggregateOutput
    for (const field of prepared.fields) {
      if (
        field === 'title' ||
        field === 'title_en' ||
        field === 'description' ||
        field === 'facts'
      ) {
        const value = answer[field]?.trim()
        if (value) {
          built.values.set(field, value)
          if (field !== 'facts') built.apply[field] = value
        } else built.refusals.set(field, reasonOf(answer.declined, field))
      } else if (field === 'tags') {
        const tags = [...new Set((answer.tags ?? []).map(tagSlug).filter((t): t is string => !!t))]
        if (tags.length > 0) {
          built.values.set('tags', tags)
          built.apply.tags = tags
        } else built.refusals.set('tags', reasonOf(answer.declined, 'tags'))
      } else if (field === 'chronology') {
        const moments = new Map(prepared.frames.map((frame) => [frame.n, frame.ms]))
        const segments = (answer.chronology ?? [])
          .flatMap((segment) => {
            const atMs = moments.get(segment.n)
            const text = segment.text.trim()
            return atMs !== undefined && atMs !== null && text ? [{ atMs, text }] : []
          })
          .sort((a, b) => a.atMs - b.atMs)
        if (segments.length > 0) {
          built.values.set(
            'chronology',
            segments.map((s) => ({ at_ms: s.atMs, text: s.text })),
          )
          built.apply.chronology = segments
        } else built.refusals.set('chronology', reasonOf(answer.declined, 'chronology'))
      }
    }
    return built
  }
  const answer = output as TextsOutput
  const wall = answer.wall?.trim()
  const message = answer.message?.trim()
  if (wall && message) {
    built.values.set('platform_texts', { wall, message })
    built.apply.platform_texts = { wall, message }
  } else {
    built.refusals.set('platform_texts', reasonOf(answer.declined, wall ? 'message' : 'wall'))
  }
  return built
}

async function insertSuggestions(
  tx: Tx,
  modelId: string,
  runId: string,
  values: ReadonlyMap<string, unknown>,
  refusals: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [field, value] of values) {
    await tx.execute(sql`
      INSERT INTO annotation_suggestions (model_id, run_id, field, value)
      VALUES (${modelId}::uuid, ${runId}::uuid, ${field}, ${JSON.stringify(value)}::jsonb)
      ON CONFLICT ON CONSTRAINT annotation_suggestions_field DO NOTHING`)
  }
  for (const [field, reason] of refusals) {
    await tx.execute(sql`
      INSERT INTO annotation_suggestions (model_id, run_id, field, refusal_reason)
      VALUES (${modelId}::uuid, ${runId}::uuid, ${field}, ${reason.slice(0, 500)})
      ON CONFLICT ON CONSTRAINT annotation_suggestions_field DO NOTHING`)
  }
}

function costOf(usage: Usage | null, price: Price, reserved: number): number {
  return usage ? cents(usdOf(usage, price)) : reserved
}

async function settleAnswer(
  ctx: ChainContext,
  stage: Stage,
  choice: RouteProvider,
  runId: string,
  attempt: number,
  price: Price,
  routeName: string,
  configDigest: string,
  prepared: Prepared,
  result: VisionResult<unknown>,
  sent: Sent | null,
  seen: FieldVersions,
): Promise<StageOutcome> {
  const { db, subject } = ctx
  const usage = result.usage
  // A refusal without usage (the policy's 400) is not paid; an answer without it is paid at the reserve.
  const cost = result.kind === 'refused' && !usage ? 0 : costOf(usage, price, Number.NaN)
  const built =
    result.kind === 'answer'
      ? build(stage, result.output, prepared, subject.privacy)
      : {
          values: new Map<string, unknown>(),
          refusals: new Map(prepared.fields.map((field) => [field, result.reason])),
          apply: {},
        }
  const answered = [...built.values.keys()].filter((field) => field !== 'facts')
  const state: values.AnnotationRunState =
    result.kind === 'refused' ||
    built.values.size === 0 ||
    (stage === 'aggregate' && answered.length === 0)
      ? 'refused'
      : built.refusals.size > 0
        ? 'partial'
        : 'succeeded'
  const reason =
    result.kind === 'refused'
      ? result.reason
      : state === 'refused'
        ? ([...built.refusals.values()][0] ?? 'пустой ответ')
        : null
  if (state === 'refused' && !ctx.probe) {
    for (const field of downstream(ctx, stage)) {
      if (!built.refusals.has(field) && !built.values.has(field))
        built.refusals.set(field, reason ?? 'отказ')
    }
  }
  return withActorTx(db, context('annotation.request', ctx.workId, subject.itemId), async (tx) => {
    const { rows } = await tx.execute<{ reserved: number }>(sql`
      SELECT reserved_usd::float8 AS reserved FROM annotation_runs
       WHERE model_id = ${subject.modelId}::uuid AND id = ${runId}::uuid AND state = 'running'
       FOR UPDATE`)
    // Settled meanwhile (a stopped worker's run taken as unknown): the first settlement stands.
    if (!rows[0])
      throw new WorkError('permanent', 'outcome_unknown', 'запрос уже рассчитан как неизвестный')
    const paid = Number.isNaN(cost) ? rows[0].reserved : cost
    await tx.execute(sql`
      UPDATE annotation_runs
         SET state = ${state}, cost_usd = ${paid}, finished_at = now(),
             tokens = ${usage ? JSON.stringify(usage) : null}::jsonb,
             request_sha256 = ${sent ? sent.sha256 : null}::bytea,
             request_bytes = ${sent ? sent.bytes : null},
             provider_request_id = ${result.requestId},
             refusal_reason = ${state === 'refused' ? (reason ?? 'отказ') : null},
             raw_response = ${JSON.stringify(result.envelope)}::jsonb
       WHERE model_id = ${subject.modelId}::uuid AND id = ${runId}::uuid`)
    await insertSuggestions(tx, subject.modelId, runId, built.values, built.refusals)
    if (!ctx.probe && state !== 'refused') {
      const applied = await applySuggestions(
        tx,
        {
          modelId: subject.modelId,
          itemId: subject.itemId,
          versionId: subject.versionId,
          runId,
          seen,
        },
        built.apply,
      )
      for (const [field, version] of applied) {
        await tx.execute(sql`
          UPDATE annotation_suggestions SET applied_at = now(), applied_value_version = ${version}
           WHERE model_id = ${subject.modelId}::uuid AND run_id = ${runId}::uuid AND field = ${field}`)
      }
    }
    const outcome: ReceiptOutcome =
      state === 'refused' ? 'refused' : state === 'partial' ? 'partial' : 'answered'
    await logReceipt(tx, {
      runId,
      modelId: subject.modelId,
      itemId: subject.itemId,
      publicId: subject.publicId,
      stage,
      provider: choice.provider,
      model: choice.model,
      attempt,
      route: routeName,
      configDigest,
      frames: prepared.frames.map((frame) => frame.artifact),
      sent,
      outcome,
      costUsd: paid,
      requestId: result.requestId,
      tokens: usage,
      workId: ctx.workId,
    })
    return state === 'refused'
      ? { kind: 'refused', stage, runIds: [runId] }
      : { kind: 'answered', stage, runId, state }
  })
}

const FAILURE_OUTCOME: Record<VisionError['kind'], ReceiptOutcome> = {
  auth_rejected: 'auth_rejected',
  rate_limited: 'rate_limited',
  transient: 'transient',
  unknown_outcome: 'unknown',
  bad_request: 'bad_request',
  bad_response: 'bad_response',
}

async function settleFailure(
  ctx: ChainContext,
  stage: Stage,
  choice: RouteProvider,
  runId: string,
  attempt: number,
  reserved: number,
  price: Price,
  routeName: string,
  configDigest: string,
  prepared: Prepared,
  failure: VisionError,
  sent: Sent | null,
): Promise<void> {
  const { db, subject } = ctx
  const unknown = failure.kind === 'unknown_outcome'
  // Unknown — counted at the reserve; a broken answer — at its usage, else at the reserve;
  // a failure the provider said it did not take — nothing.
  const cost = unknown
    ? reserved
    : failure.kind === 'bad_response'
      ? costOf(failure.usage, price, reserved)
      : 0
  await withActorTx(db, context('annotation.request', ctx.workId, subject.itemId), async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE annotation_runs
         SET state = 'failed', cost_usd = ${cost}, finished_at = now(), outcome_unknown = ${unknown},
             error_code = ${failure.kind === 'unknown_outcome' ? 'outcome_unknown' : failure.kind},
             error = ${failure.message.slice(0, 500)},
             request_sha256 = ${sent ? sent.sha256 : null}::bytea,
             request_bytes = ${sent ? sent.bytes : null},
             provider_request_id = ${failure.requestId},
             tokens = ${failure.usage ? JSON.stringify(failure.usage) : null}::jsonb,
             raw_response = ${failure.status === null ? null : JSON.stringify({ status: failure.status })}::jsonb
       WHERE model_id = ${subject.modelId}::uuid AND id = ${runId}::uuid AND state = 'running'
      RETURNING id`)
    if (!rows[0]) return
    await logReceipt(tx, {
      runId,
      modelId: subject.modelId,
      itemId: subject.itemId,
      publicId: subject.publicId,
      stage,
      provider: choice.provider,
      model: choice.model,
      attempt,
      route: routeName,
      configDigest,
      frames: prepared.frames.map((frame) => frame.artifact),
      sent,
      outcome: FAILURE_OUTCOME[failure.kind],
      costUsd: cost,
      requestId: failure.requestId,
      tokens: failure.usage,
      workId: ctx.workId,
    })
  })
}

/** A request a stopped worker left in flight: unknown, paid at its reserve, never sent again. */
async function settleUnknown(
  ctx: ChainContext,
  stage: Stage,
  choice: RouteProvider,
  run: RunRow,
  routeName: string,
  configDigest: string,
  prepared: Prepared,
): Promise<void> {
  const { db, subject } = ctx
  await withActorTx(db, context('annotation.request', ctx.workId, subject.itemId), async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE annotation_runs
         SET state = 'failed', outcome_unknown = true, error_code = 'outcome_unknown',
             error = 'обработчик остановился во время запроса', cost_usd = reserved_usd,
             finished_at = now()
       WHERE model_id = ${subject.modelId}::uuid AND id = ${run.id}::uuid AND state = 'running'
      RETURNING id`)
    if (!rows[0]) return
    await logReceipt(tx, {
      runId: run.id,
      modelId: subject.modelId,
      itemId: subject.itemId,
      publicId: subject.publicId,
      stage,
      provider: choice.provider,
      model: choice.model,
      attempt: run.attempt,
      route: routeName,
      configDigest,
      frames: prepared.frames.map((frame) => frame.artifact),
      sent: null,
      outcome: 'unknown',
      costUsd: run.reserved_usd,
      requestId: null,
      tokens: null,
      workId: ctx.workId,
    })
  })
}
