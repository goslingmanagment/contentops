/**
 * `@contentops/mock-api` — the in-memory server of the prototype (SPEC §12.0): the API paths
 * of `@contentops/contracts` answered from fixtures, with the `?demo=` states and the `?as=`
 * roles. Development and tests only: the product build never contains it.
 */

export { createMockFetch, type MockFetch } from './mock-fetch'
export {
  type DemoMode,
  DemoModeSchema,
  type MockOptions,
  type PrototypeRole,
  PrototypeRoleSchema,
} from './options'
export { createPrototypeClock, PROTOTYPE_NOW, PROTOTYPE_TODAY } from './prototype-clock'
