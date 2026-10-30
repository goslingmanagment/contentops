import {
  IssueTokenCommandSchema,
  RemoveThresholdCommandSchema,
  UpdateIntegrationCommandSchema,
  UpdateThresholdCommandSchema,
} from '../../commands/settings'
import { AgentSchema, IssuedTokenSchema } from '../../domain/agents'
import { TagSchema } from '../../domain/markup'
import { ModelSchema } from '../../domain/model'
import { OperationAcceptedSchema, OperationSchema } from '../../domain/operations'
import { pageSchema } from '../../domain/pagination'
import { PersonSchema, SessionPrincipalSchema } from '../../domain/people'
import { CountersSchema, SystemStateSchema, ThresholdSchema } from '../../domain/system'
import { IntegrationViewSchema, OkSchema } from '../responses'
import { defineRoute } from '../route'

/** Routes without a model: session, counters, settings and system operations. */
export const adminRoutes = {
  me: defineRoute({ method: 'GET', path: '/api/v1/admin/me', response: SessionPrincipalSchema }),
  counters: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/counters',
    response: CountersSchema,
  }),
  models: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/models',
    response: pageSchema(ModelSchema),
  }),
  people: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/people',
    response: pageSchema(PersonSchema),
  }),
  agents: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/agents',
    response: pageSchema(AgentSchema),
  }),
  issueToken: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/agents/{agent}/tokens',
    body: IssueTokenCommandSchema,
    response: IssuedTokenSchema,
    success: 201,
  }),
  revokeToken: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/agents/{agent}/tokens/{token}:revoke',
    response: AgentSchema,
  }),
  integrations: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/integrations',
    response: pageSchema(IntegrationViewSchema),
  }),
  updateIntegration: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/integrations/{integration}',
    body: UpdateIntegrationCommandSchema,
    response: IntegrationViewSchema,
  }),
  thresholds: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/thresholds',
    response: pageSchema(ThresholdSchema),
  }),
  updateThreshold: defineRoute({
    method: 'PUT',
    path: '/api/v1/admin/thresholds',
    body: UpdateThresholdCommandSchema,
    response: ThresholdSchema,
  }),
  removeThreshold: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/thresholds:remove',
    body: RemoveThresholdCommandSchema,
    response: OkSchema,
  }),
  tags: defineRoute({ method: 'GET', path: '/api/v1/admin/tags', response: pageSchema(TagSchema) }),
  state: defineRoute({ method: 'GET', path: '/api/v1/admin/state', response: SystemStateSchema }),
  operation: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/operations/{operation}',
    response: OperationSchema,
  }),
  /**
   * `verify-blobs` (SPEC §11.2): hashes of `blobs/` against the database and the blobs
   * without references; the report comes in the operation. Removal is the owner's command.
   */
  verifyBlobs: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/blobs:verify',
    response: OperationAcceptedSchema,
    success: 202,
  }),
}
