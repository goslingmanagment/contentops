import type { PathParams, Route } from '@contentops/contracts/api/route'
import type { ApiRoutes } from '@contentops/contracts/api/routes/index'
import type { z } from 'zod'
import type { NotModified, RequestContext } from './context'
import type { FileAnswer } from './file-answer'

/** What a handler gets: everything already checked by the route's schemas. */
export interface HandlerInput<R extends Route> {
  params: PathParams<R['path']>
  query: z.output<R['query']>
  body: z.output<R['body']>
  ctx: RequestContext
}

/**
 * Returns the answer before its schema; the server validates it and sends `route.success`.
 * A read of a whole resource may answer `NotModified` (304); a file route answers with a
 * `FileAnswer`: headers and `X-Accel-Redirect`, no JSON.
 */
export type RouteHandler<R extends Route> = (
  input: HandlerInput<R>,
) =>
  | z.input<R['response']>
  | NotModified
  | FileAnswer
  | Promise<z.input<R['response']> | NotModified | FileAnswer>

type AreaHandlers<Area> = {
  [Name in keyof Area]?: Area[Name] extends Route ? RouteHandler<Area[Name]> : never
}

/**
 * Handlers by area and route name of `apiRoutes`; a route without one answers 501
 * `not_implemented`. Areas are filled module by module as the server grows.
 */
export type HandlerRegistry = { [Area in keyof ApiRoutes]?: AreaHandlers<ApiRoutes[Area]> }
