import { type ApiRoutes, apiRoutes, type Route } from '@contentops/contracts'

type ServerRoutes = { [Area in keyof ApiRoutes]?: 'all' | readonly (keyof ApiRoutes[Area])[] }

/**
 * Пути API, на которые уже отвечает сервер: область таблицы маршрутов целиком (`'all'`) или
 * её пути по именам, например `{ auth: 'all', settings: 'all', plan: ['norm', 'updateNorm'] }`.
 * Экраны переходят на сервер по областям — дописыванием сюда. Остальное в разработке
 * отвечает заглушка (`@contentops/mock-api`); в сборке продукта заглушки нет и все запросы
 * идут на сервер.
 */
export const SERVER_ROUTES: ServerRoutes = {
  auth: 'all',
  admin: [
    'me',
    'models',
    'people',
    'agents',
    'issueToken',
    'revokeToken',
    'integrations',
    'updateIntegration',
    'thresholds',
    'updateThreshold',
    'removeThreshold',
    'state',
    'counters',
  ],
  settings: [
    'addPerson',
    'updatePerson',
    'revokePersonSessions',
    'revokeAccess',
    'modelPeople',
    'personGrants',
    'mySessions',
    'revokeMySession',
    'updateProfile',
    'changePassword',
    'addModel',
    'addAccount',
    'connectIntegration',
    'ai',
    'pauseQueue',
  ],
  plan: ['norm', 'updateNorm'],
  journal: 'all',
}

const onServer = new Set<Route>(
  Object.entries(SERVER_ROUTES).flatMap(([area, names]) => {
    const routes: Record<string, Route> = apiRoutes[area as keyof ApiRoutes]
    const picked: readonly string[] = names === 'all' ? Object.keys(routes) : (names ?? [])
    return picked.flatMap((name) => routes[name] ?? [])
  }),
)

/** Путь из списка `SERVER_ROUTES`: в разработке он идёт на сервер, а не в заглушку. */
export function isServerRoute(route: Route): boolean {
  return onServer.has(route)
}
