import type { BoundRoute } from '../handler'
import { adminHandlers } from './admin'
import { checkHandlers } from './check'
import { inboxHandlers } from './inbox'
import { markupHandlers } from './markup'
import { objectBatchHandlers } from './object-batch'
import { objectFileHandlers } from './object-files'
import { objectHandlers } from './objects'
import { orderHandlers } from './orders'
import { planHandlers } from './plan'
import { promoHandlers } from './promo'
import { settingsHandlers } from './settings'
import { uploadHandlers } from './uploads'

/** Every route the mock answers, ordered so that literal paths win over parameters. */
export function allHandlers(): BoundRoute[] {
  const handlers = [
    ...adminHandlers(),
    ...objectHandlers(),
    ...objectFileHandlers(),
    ...objectBatchHandlers(),
    ...markupHandlers(),
    ...inboxHandlers(),
    ...planHandlers(),
    ...checkHandlers(),
    ...orderHandlers(),
    ...promoHandlers(),
    ...settingsHandlers(),
    ...uploadHandlers(),
  ]
  const parameters = (handler: BoundRoute) => (handler.route.path.match(/\{/g) ?? []).length
  return handlers.sort((left, right) => parameters(left) - parameters(right))
}
