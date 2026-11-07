import {
  type Db,
  type EnqueueResult,
  enqueueWork,
  type Queryable,
  values,
  type WorkHandler,
} from '@contentops/db'
import type { MarkupType, Stage } from '@contentops/vision'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { BlobStore } from '../media/storage'
import type { ProviderRegistry } from './providers'
import { annotationSettings, MARKUP_TYPES, RouteProviderSchema } from './settings'
import { type ChainContext, DEFAULT_TIMEOUT_MS, runStage, type StageOutcome } from './stage'
import { loadSubject } from './subject'

/**
 * The work `annotate` of the role `worker` (schema §9.8): the stages of one object in order —
 * frames, fields, texts — each a run of its own. A later stage reads the earlier one's answer,
 * so the chain stops where a stage got no answer. `dataset` tells the kind: `routine` goes by
 * the routes and writes the fields, `probe` is the measurement with the owner's provider and
 * model, its answers only compared (PLAN 8а).
 *
 * Nothing is queued before the owner switches the markup on (SPEC §8.3): `enqueueAnnotation`
 * refuses without `annotation.enabled` and a route of the first stage, `enqueueProbe` without
 * the provider's consent and a budget.
 */

const Plan = z.object({
  stages: z.array(z.enum(values.annotationStages)).min(1),
  probe: RouteProviderSchema.extend({ frames: z.int().min(1).max(100).optional() })
    .nullable()
    .default(null),
})
export type AnnotatePlan = z.infer<typeof Plan>

export interface AnnotateDeps {
  store: BlobStore
  providers: ProviderRegistry
  timeoutMs?: number
}

export function annotateHandler(deps: AnnotateDeps): WorkHandler {
  return async ({ work, db, signal }) => {
    const plan = Plan.parse((work.checkpoint as { plan?: unknown } | null)?.plan)
    if (!work.modelId || !work.scope) throw new Error('annotate: a work without its object')
    const subject = await loadSubject(db, work.modelId, work.scope)
    if (!subject) return { report: { skipped: 'объекта нет или в нём нечего размечать' } }
    const ctx: ChainContext = {
      db,
      store: deps.store,
      providers: deps.providers,
      settings: await annotationSettings(db, work.modelId),
      subject,
      workId: work.id,
      signal,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      probe: plan.probe,
      stages: plan.stages,
    }
    const stages: StageOutcome[] = []
    for (const stage of plan.stages) {
      const outcome = await runStage(ctx, stage)
      stages.push(outcome)
      if (outcome.kind !== 'answered') break
    }
    return { report: { item: subject.publicId, stages } }
  }
}

/** The stages of a type in order; texts only for PPV. */
export function stagesOf(type: MarkupType): Stage[] {
  return type === 'PPV' ? ['observe', 'aggregate', 'texts'] : ['observe', 'aggregate']
}

interface ItemRef extends Record<string, unknown> {
  id: string
  type: string
}

async function itemOf(q: Queryable, modelId: string, itemId: string): Promise<ItemRef | null> {
  const { rows } = await q.execute<ItemRef>(sql`
    SELECT id, type FROM content_items
     WHERE model_id = ${modelId}::uuid AND id = ${itemId}::uuid AND deleted_at IS NULL`)
  return rows[0] ?? null
}

export type Queued =
  | { queued: true; work: EnqueueResult['work']; created: boolean; stages: Stage[] }
  | { queued: false; reason: string }

/**
 * Puts the markup of an object by its routes: the stages from the first one that has a route,
 * as long as the next ones have theirs. `pass` names the pass (a day, a tranche): the same pass
 * finds the same work, a new pass makes a new one — and its runs find the answers already got.
 */
export async function enqueueAnnotation(
  q: Queryable,
  input: { modelId: string; itemId: string; pass: string },
): Promise<Queued> {
  const settings = await annotationSettings(q, input.modelId)
  if (!settings.enabled) return { queued: false, reason: 'разметка выключена (annotation.enabled)' }
  const item = await itemOf(q, input.modelId, input.itemId)
  if (!item || !(MARKUP_TYPES as readonly string[]).includes(item.type)) {
    return { queued: false, reason: 'объекта нет или его тип не размечается' }
  }
  const type = item.type as MarkupType
  const stages: Stage[] = []
  for (const stage of stagesOf(type)) {
    if (!settings.routes.has(`${type}.${stage}`)) break
    if (stage === 'texts' && !settings.texts) break
    stages.push(stage)
  }
  if (stages.length === 0) return { queued: false, reason: `у ${type} нет маршрута кадров` }
  const plan: AnnotatePlan = { stages, probe: null }
  const { work, created } = await enqueueWork(q, {
    modelId: input.modelId,
    kind: 'annotate',
    workKey: `annotate:${input.itemId}:${stages.join('+')}:${input.pass}`,
    scope: input.itemId,
    dataset: 'routine',
    priority: -10,
    checkpoint: { plan },
  })
  return { queued: true, work, created, stages }
}

/**
 * Puts a measurement run of an object (PLAN 8а): the provider and model the owner names, the
 * stages asked; nothing reaches a field. Without the provider's consent or a budget nothing is
 * queued; the checks of the run itself (types, stages, frames of the consent, the reserve) go
 * on in the worker.
 */
export async function enqueueProbe(
  db: Db | Queryable,
  input: {
    modelId: string
    itemId: string
    stages: Stage[]
    probe: NonNullable<AnnotatePlan['probe']>
    pass: string
  },
): Promise<Queued> {
  const settings = await annotationSettings(db, input.modelId)
  if (!settings.consents.has(input.probe.provider)) {
    return { queued: false, reason: `нет согласия на ${input.probe.provider}` }
  }
  if (!settings.budget) return { queued: false, reason: 'бюджет не задан (annotation.budget)' }
  const item = await itemOf(db, input.modelId, input.itemId)
  if (!item || !(MARKUP_TYPES as readonly string[]).includes(item.type)) {
    return { queued: false, reason: 'объекта нет или его тип не размечается' }
  }
  const stages = input.stages.filter((stage) => stage !== 'texts' || item.type === 'PPV')
  if (stages.length === 0) return { queued: false, reason: 'тексты для платформы — только у PPV' }
  const plan: AnnotatePlan = { stages, probe: input.probe }
  const { work, created } = await enqueueWork(db, {
    modelId: input.modelId,
    kind: 'annotate',
    workKey: `annotate:probe:${input.itemId}:${input.probe.provider}:${input.probe.model}:${stages.join('+')}:${input.pass}`,
    scope: input.itemId,
    dataset: 'probe',
    priority: 10,
    checkpoint: { plan },
  })
  return { queued: true, work, created, stages }
}
