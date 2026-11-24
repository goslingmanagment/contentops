import { sql } from 'drizzle-orm'
import { requireActor } from '../commands'
import { ApiProblem } from '../errors'
import type { HandlerRegistry } from '../handlers'
import { originalsRelease } from '../originals/release'
import type { Services } from '../services'

/**
 * «Оригиналы» for the PC (SPEC §9.4, §12.2): what a holder of the PC may free now. The route is
 * the owner's and the host agent's (`access.ts`, `originals.host_agent`); the agent also needs
 * the model in its grants.
 */
export function originalsHandlers({ db, originalsHostDir }: Services): HandlerRegistry {
  return {
    admin: {
      originalsRelease: async ({ query, ctx }) => {
        const actor = requireActor(ctx)
        if (actor.role !== 'owner' && !actor.models.includes(query.model)) {
          throw new ApiProblem('forbidden', 'Нет доступа к этой модели')
        }
        const { rows } = await db.execute<{ id: string }>(sql`
          SELECT id FROM models WHERE code = ${query.model} AND archived_at IS NULL`)
        const model = rows[0]
        if (!model) throw new ApiProblem('not_found', 'Такой модели нет')
        return originalsRelease(db, model.id, {
          model: query.model,
          holder: query.holder,
          hostDir: originalsHostDir ?? null,
        })
      },
    },
  }
}
