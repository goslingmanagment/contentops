import { WaitingSchema } from '../../domain/waiting'
import { defineRoute } from '../route'

/** «Ждут вас» of a model: the person's open matters from Hub (domain/waiting.ts). */
export const waitingRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/waiting',
    response: WaitingSchema,
  }),
}
