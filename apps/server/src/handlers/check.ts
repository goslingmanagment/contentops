import type { Queryable } from '@contentops/db'
import { modelOf } from '../catalog/ids'
import { requireActor } from '../commands'
import type { ModelScope } from '../context'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import {
  allCases,
  checkModel,
  parseCase,
  postCase,
  resolvedCases,
  rowCase,
  unverifiedRows,
  unverifiedSummary,
} from '../hub/check/cases'
import {
  bindPost,
  confirmPair,
  confirmUnambiguous,
  outsidePost,
  rejectPair,
  undoDecision,
} from '../hub/check/decisions'
import { loadState } from '../plan/state'
import type { Services } from '../services'

/**
 * «План › Сверить» on the server (DESIGN §4.15, SPEC §7): the cases where Hub doubts or a post
 * went out without plan, and the decisions on them. Everyone with the model reads; the owner,
 * managers and agents decide (an agent's decision is marked «подтверждено агентом»).
 */
export function checkHandlers({ db, command }: Services): HandlerRegistry {
  const load = async (q: Queryable, model: ModelScope) => checkModel(q, await loadState(q, model))

  return {
    check: {
      list: async ({ ctx }) => {
        const model = modelOf(ctx.model)
        const check = await load(db, model)
        const items = await allCases(db, check)
        const unverified = unverifiedRows(check)
        return {
          items,
          next_cursor: null,
          unverified: unverifiedSummary(unverified),
          resolved_count: (await resolvedCases(db, check, 'resolved')).length,
          not_ours_count: (await resolvedCases(db, check, 'not_ours')).length,
          unambiguous_ids: items.filter((item) => item.unambiguous).map((item) => item.id),
        }
      },

      resolved: async ({ ctx }) => ({
        items: await resolvedCases(db, await load(db, modelOf(ctx.model)), 'resolved'),
        next_cursor: null,
      }),

      notOurs: async ({ ctx }) => ({
        items: await resolvedCases(db, await load(db, modelOf(ctx.model)), 'not_ours'),
        next_cursor: null,
      }),

      unverified: async ({ ctx }) => ({
        items: unverifiedRows(await load(db, modelOf(ctx.model))),
        next_cursor: null,
      }),

      get: async ({ params, ctx }) => {
        const model = modelOf(ctx.model)
        const ref = parseCase(params.case)
        const check = await load(db, model)
        if (ref.kind === 'row') {
          const row = check.state.rows.find((one) => one.id === ref.id)
          if (!row) throw new ApiProblem('not_found', 'Такого случая сверки нет')
          const found = await rowCase(db, check, row)
          if (!found) throw new ApiProblem('case_resolved', 'Случай уже решён')
          return found
        }
        const open = check.postCases.find((one) => one.post.id === ref.id)
        const found = open ? postCase(check, open) : null
        if (!found) throw new ApiProblem('case_resolved', 'Случай уже решён')
        return found
      },

      confirmPair: ({ params, body, ctx }) =>
        command({ ctx, body }, (tx, actor) =>
          confirmPair(tx, modelOf(ctx.model), actor, params.case, body),
        ),

      reject: ({ params, body, ctx }) =>
        command({ ctx, body }, (tx, actor) =>
          rejectPair(tx, modelOf(ctx.model), actor, params.case, body.evidence_id),
        ),

      bind: ({ params, body, ctx }) =>
        command({ ctx, body }, (tx, actor) =>
          bindPost(tx, modelOf(ctx.model), actor, params.case, body.item_id),
        ),

      outside: ({ params, ctx }) =>
        command({ ctx, body: null }, (tx, actor) =>
          outsidePost(tx, modelOf(ctx.model), actor, params.case),
        ),

      undo: ({ params, ctx }) =>
        command({ ctx, body: null }, (tx, actor) =>
          undoDecision(tx, modelOf(ctx.model), actor, params.case),
        ),

      confirmUnambiguous: ({ body, ctx }) =>
        command({ ctx, body }, async (tx, actor) => {
          requireActor(ctx)
          return { results: await confirmUnambiguous(tx, modelOf(ctx.model), actor, body.case_ids) }
        }),
    },
  }
}
