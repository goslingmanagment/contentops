import {
  StatsMediaCardSchema,
  StatsScreenQuerySchema,
  StatsScreenSchema,
} from '../../domain/stats-screen'
import { defineRoute } from '../route'

/** «Статистика» of a model (domain/stats-screen.ts): Hub's Fansly numbers of a page, read as the signed-in person. */
export const statsRoutes = {
  screen: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/stats',
    query: StatsScreenQuerySchema,
    response: StatsScreenSchema,
  }),
  media: defineRoute({
    method: 'GET',
    path: '/api/v1/{model}/stats/media/{media}',
    query: StatsScreenQuerySchema,
    response: StatsMediaCardSchema,
  }),
}
