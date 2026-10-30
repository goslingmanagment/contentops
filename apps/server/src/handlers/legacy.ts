import type { OperationAccepted } from '@contentops/contracts/domain/operations'
import { logAction } from '@contentops/db'
import { isUuid } from '../commands'
import type { ModelScope, RequestContext } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { writeInputs } from '../legacy/inputs'
import { enqueueImport, type ImportMode } from '../legacy/parse'
import { snapshotOf } from '../legacy/snapshot'
import type { Services } from '../services'

/**
 * The legacy import of stage 3 from the API and the CLI (SPEC §6.3, §11.2): its inputs, the
 * metadata pass and the dry run. Both runs are works of the role `worker`; the answer is 202
 * with the operation, the report comes in it.
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
  const run =
    (mode: ImportMode) => (input: { query: { snapshot?: string }; ctx: RequestContext }) =>
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
        })
        if (created) {
          await logAction(tx, {
            modelId: model.id,
            subjectKind: 'work_operations',
            subjectId: work.id,
            subjectLabel: mode === 'plan' ? 'Сухой прогон импорта' : 'Разбор старых имён',
            after: { Снимок: snapshot.workKey },
          })
        }
        return accepted(model, work.id)
      })
  return {
    legacy: {
      parse: run('parse'),
      plan: run('plan'),
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
