import type { OperationAccepted } from '@contentops/contracts/domain/operations'
import { logAction } from '@contentops/db'
import { isUuid } from '../commands'
import type { ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { resolveDispute } from '../legacy/decisions'
import { writeInputs } from '../legacy/inputs'
import { saveLabelTargets } from '../legacy/labels'
import { materializeClaims } from '../legacy/materialize'
import { enqueueImport, type ImportRun } from '../legacy/parse'
import { legacyReview } from '../legacy/review'
import { snapshotOf } from '../legacy/snapshot'
import type { Services } from '../services'

/**
 * The legacy import of stage 3 from the API and the CLI (SPEC §6.3, §11.2): its inputs, the
 * metadata pass and the dry run — works of the role `worker`, 202 with the operation, the report
 * in it — and «Разбор старого» (DESIGN §4.9): the labels → pages card, whose saving turns the
 * claims of the confirmed labels into placements, and the decisions of the disputed cases.
 */

function modelOf(ctx: RequestContext): ModelScope {
  if (!ctx.model) throw new ApiProblem('not_found', 'Такой модели нет')
  return ctx.model
}

function accepted(model: ModelScope, id: string): OperationAccepted {
  return {
    kind: 'operation',
    operation_id: id,
    status_url: `/api/v1/${model.code}/operations/${id}`,
  }
}

export function legacyHandlers(services: Services): HandlerRegistry {
  const { command } = services
  const LABELS: Record<ImportRun, string> = {
    plan: 'Сухой прогон импорта',
    parse: 'Разбор старых имён',
    bytes: 'Импорт байтов',
    reconcile: 'Сверка со снимком',
  }
  const run =
    (mode: ImportRun, extra?: (query: Record<string, unknown>) => unknown) =>
    (input: { query: { snapshot?: string }; ctx: RequestContext }) =>
      command({ ctx: input.ctx, body: input.query }, async (tx) => {
        const model = modelOf(input.ctx)
        const wanted = input.query.snapshot ?? null
        if (wanted !== null && !isUuid(wanted))
          throw new ApiProblem('not_found', 'Такого снимка нет')
        const snapshot = await snapshotOf(tx, model.id, wanted)
        if (!snapshot) {
          throw new ApiProblem(
            'not_found',
            wanted ? 'Такого готового снимка нет' : 'Снимка ещё нет: сначала ops.js freeze',
          )
        }
        const { work, created } = await enqueueImport(tx, {
          modelId: model.id,
          mode,
          snapshot,
          nonce: input.ctx.requestId,
          ...(extra ? { input: extra(input.query) } : {}),
        })
        if (created) {
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'work_operations',
            subjectId: work.id,
            subjectLabel: LABELS[mode],
            after: {
              Снимок: snapshot.workKey,
              ...(extra ? { Что: JSON.stringify(extra(input.query)) } : {}),
            },
          })
        }
        return accepted(model, work.id)
      })
  const { db } = services
  return {
    legacy: {
      get: ({ ctx }) => legacyReview(db, modelOf(ctx)),
      saveLabels: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx)
          const changed = await saveLabelTargets(tx, model.id, actor.id, body.labels)
          if (changed.length > 0)
            await materializeClaims(tx, model.id, actor.id, { labels: changed })
          return legacyReview(tx, model)
        }),
      resolve: ({ params, body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          const model = modelOf(ctx)
          await resolveDispute(tx, model.id, actor.id, params.dispute, body)
          return legacyReview(tx, model)
        }),
      parse: run('parse'),
      plan: run('plan'),
      bytes: run('bytes', (query) => ({
        roots: query.root as string[],
        folder: (query.folder as string | undefined) ?? null,
        force: query.force === 'true',
      })),
      reconcile: run('reconcile'),
      inputs: ({ body, ctx }) =>
        command({ ctx, body }, (tx, actor) =>
          writeInputs(tx, modelOf(ctx).id, actor.id, {
            ...(body.registry !== undefined ? { registry: body.registry } : {}),
            ...(body.vault_albums !== undefined ? { vault_albums: body.vault_albums } : {}),
          }),
        ),
    },
  }
}
