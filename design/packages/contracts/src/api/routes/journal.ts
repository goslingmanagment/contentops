import { JournalEventSchema, JournalFilterSchema } from '../../domain/journal'
import { OperationSchema } from '../../domain/operations'
import { PageQuerySchema, pageSchema } from '../../domain/pagination'
import { defineRoute } from '../route'

export const JournalQuerySchema = PageQuerySchema.extend(JournalFilterSchema.shape)

export const journalRoutes = {
  list: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/journal',
    query: JournalQuerySchema,
    response: pageSchema(JournalEventSchema),
  }),
}

/** Long operations of a model: copies, ZIPs, handoffs (DESIGN §3.13, п. 7). */
export const operationRoutes = {
  get: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/operations/{operation}',
    response: OperationSchema,
  }),
}
