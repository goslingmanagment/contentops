import { createBrowserHistory, createRouter } from '@tanstack/react-router'
import { routeTree } from './route-tree'

/** Адреса DESIGN §2.4 — обычные пути (`/lora/library`) на `createBrowserHistory` (§9.1). */
export function createAppRouter() {
  return createRouter({
    routeTree,
    history: createBrowserHistory(),
    defaultPreload: 'intent',
    notFoundMode: 'fuzzy',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
