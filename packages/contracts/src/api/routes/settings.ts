import {
  AddAccountCommandSchema,
  AddAgentCommandSchema,
  AddAiServiceCommandSchema,
  AddContractorCommandSchema,
  AddModelCommandSchema,
  AddPersonCommandSchema,
  ChangePasswordCommandSchema,
  ConnectIntegrationCommandSchema,
  MergeTagCommandSchema,
  PauseQueueCommandSchema,
  SignInCommandSchema,
  UpdateAgentCommandSchema,
  UpdateAiBudgetCommandSchema,
  UpdateAiServiceCommandSchema,
  UpdateContractorCommandSchema,
  UpdatePersonCommandSchema,
  UpdateProfileCommandSchema,
  UpdateTagCommandSchema,
} from '../../commands/admin'
import {
  AccessGrantSchema,
  AiSettingsSchema,
  PersonCreatedSchema,
  SessionSchema,
  SignInResultSchema,
} from '../../domain/admin'
import { AgentSchema } from '../../domain/agents'
import { TagSchema } from '../../domain/markup'
import { ModelSchema } from '../../domain/model'
import { pageSchema } from '../../domain/pagination'
import { PersonSchema } from '../../domain/people'
import { PersonRefSchema } from '../../domain/plan'
import { ContractorSchema } from '../../domain/promo'
import { SystemStateSchema } from '../../domain/system'
import { IntegrationViewSchema, OkSchema } from '../responses'
import { defineRoute } from '../route'

/** Changes of the owner's settings (DESIGN §4.19): people, pages, tags, queues, AI. */
export const settingsRoutes = {
  addPerson: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/people',
    body: AddPersonCommandSchema,
    response: PersonCreatedSchema,
    success: 201,
  }),
  updatePerson: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/people/{person}',
    body: UpdatePersonCommandSchema,
    response: PersonSchema,
    versioned: true,
  }),
  revokePersonSessions: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/people/{person}/sessions:revoke',
    response: PersonSchema,
  }),
  /** «Отозвать доступ…»: the person can no longer sign in. */
  revokeAccess: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/people/{person}:revoke-access',
    response: OkSchema,
  }),
  /** «Добавить агента» (DESIGN §4.19); the token is issued separately, «Выдать токен». */
  addAgent: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/agents',
    body: AddAgentCommandSchema,
    response: AgentSchema,
    success: 201,
  }),
  /** Name, role and models of an agent; its tokens follow at once. */
  updateAgent: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/agents/{agent}',
    body: UpdateAgentCommandSchema,
    response: AgentSchema,
    versioned: true,
  }),
  /**
   * Names of the people with rights on the model, for anyone who may see it: «обычно
   * выкладывает Никита» in «Страницы и нормы» of a КМ. Logins, roles and sessions stay owner-only.
   */
  modelPeople: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/people',
    response: pageSchema(PersonRefSchema),
  }),
  personGrants: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/people/{person}/grants',
    response: pageSchema(AccessGrantSchema),
  }),
  mySessions: defineRoute({
    method: 'GET',
    path: '/api/v1/admin/me/sessions',
    response: pageSchema(SessionSchema),
  }),
  revokeMySession: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/me/sessions/{session}:revoke',
    response: pageSchema(SessionSchema),
  }),
  updateProfile: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/me',
    body: UpdateProfileCommandSchema,
    response: PersonSchema,
  }),
  changePassword: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/me/password',
    body: ChangePasswordCommandSchema,
    response: OkSchema,
  }),
  addModel: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/models',
    body: AddModelCommandSchema,
    response: ModelSchema,
    success: 201,
  }),
  addAccount: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/models/{model}/accounts',
    body: AddAccountCommandSchema,
    response: ModelSchema,
    success: 201,
  }),
  /** Contractors are read by everyone with the model: `promo.contractors`. */
  addContractor: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/models/{model}/contractors',
    body: AddContractorCommandSchema,
    response: ContractorSchema,
    success: 201,
  }),
  updateContractor: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/models/{model}/contractors/{contractor}',
    body: UpdateContractorCommandSchema,
    response: ContractorSchema,
    versioned: true,
  }),
  updateTag: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/tags/{tag}',
    body: UpdateTagCommandSchema,
    response: TagSchema,
    versioned: true,
  }),
  mergeTag: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/tags/{tag}:merge',
    body: MergeTagCommandSchema,
    response: TagSchema,
  }),
  pauseQueue: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/state/queues/{queue}:pause',
    body: PauseQueueCommandSchema,
    response: SystemStateSchema,
  }),
  connectIntegration: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/integrations/{integration}:connect',
    body: ConnectIntegrationCommandSchema,
    response: IntegrationViewSchema,
  }),
  ai: defineRoute({ method: 'GET', path: '/api/v1/admin/ai', response: AiSettingsSchema }),
  addAiService: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/ai/services',
    body: AddAiServiceCommandSchema,
    response: AiSettingsSchema,
    success: 201,
  }),
  updateAiService: defineRoute({
    method: 'PATCH',
    path: '/api/v1/admin/ai/services/{service}',
    body: UpdateAiServiceCommandSchema,
    response: AiSettingsSchema,
  }),
  updateAiBudget: defineRoute({
    method: 'PUT',
    path: '/api/v1/admin/ai/budget',
    body: UpdateAiBudgetCommandSchema,
    response: AiSettingsSchema,
  }),
  /** «Включить» after a stop or a manual switch-off. */
  resumeAi: defineRoute({
    method: 'POST',
    path: '/api/v1/admin/ai:resume',
    response: AiSettingsSchema,
  }),
}

/** Sign-in and sign-out; every other route answers 401 until the person signs in (§3.10). */
export const authRoutes = {
  signIn: defineRoute({
    method: 'POST',
    path: '/api/v1/auth/sign-in',
    body: SignInCommandSchema,
    response: SignInResultSchema,
  }),
  signOutEverywhere: defineRoute({
    method: 'POST',
    path: '/api/v1/auth/sign-out-everywhere',
    response: OkSchema,
  }),
}
