import { createHashHistory, createRouter } from '@tanstack/react-router'
import { routeTree } from './route-tree'

/**
 * Прототип живёт на hash-адресах и открывается двойным щелчком (file://); в продукте те
 * же маршруты работают на `createBrowserHistory` (DESIGN §9.1).
 */
export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createHashHistory(),
    defaultPreload: 'intent',
    notFoundMode: 'fuzzy',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
