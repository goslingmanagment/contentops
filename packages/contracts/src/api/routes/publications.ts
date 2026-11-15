import {
  PublicationCardSchema,
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
}
