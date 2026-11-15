import { z } from 'zod'
import {
  PublicationActionAnswerSchema,
  PublicationApproveCommandSchema,
  PublicationCardSchema,
  PublicationPageSettingsCommandSchema,
  PublicationResolveCommandSchema,
  PublicationSwitchesSchema,
  PublicationSwitchSetCommandSchema,
  PublicationsFeedQuerySchema,
  PublicationsFeedSchema,
} from '../../domain/publications-screen'
import { defineRoute } from '../route'

/** «Публикации» of a model (domain/publications-screen.ts): Hub's publications, read as the signed-in person. */
export const publicationRoutes = {
  feed: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/publications',
    query: PublicationsFeedQuerySchema,
    response: PublicationsFeedSchema,
  }),
  card: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/publications/{publication}',
    response: PublicationCardSchema,
  }),
  // The actions, each done by Hub as the signed-in person; Hub says yes or no (package C2, PR 3).
  approve: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:approve',
    body: PublicationApproveCommandSchema,
    response: PublicationActionAnswerSchema,
  }),
  cancel: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:cancel',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  withdraw: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:withdraw',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  replace: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:replace',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  resolve: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:resolve',
    body: PublicationResolveCommandSchema,
    response: PublicationActionAnswerSchema,
  }),
  deletePost: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publications/{publication}:delete-post',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  refreshPage: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publication-pages/{page}:refresh',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  withdrawPage: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publication-pages/{page}:withdraw-all',
    body: z.object({}),
    response: PublicationActionAnswerSchema,
  }),
  pageSettings: defineRoute({
    method: 'PUT',
    path: '/api/v1/{model}/publication-pages/{page}/settings',
    body: PublicationPageSettingsCommandSchema,
    response: PublicationActionAnswerSchema,
  }),
  switches: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/publication-switches',
    response: PublicationSwitchesSchema,
  }),
  setSwitches: defineRoute({
    method: 'POST',
    path: '/api/v1/{model}/publication-switches',
    body: PublicationSwitchSetCommandSchema,
    response: PublicationActionAnswerSchema,
  }),
}
