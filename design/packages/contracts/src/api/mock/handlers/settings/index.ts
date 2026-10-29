import type { BoundRoute } from '../../handler'
import { aiHandlers } from './ai'
import { pagesHandlers } from './pages'
import { peopleHandlers } from './people'
import { profileHandlers } from './profile'
import { systemHandlers } from './system'
import { tagHandlers } from './tags'
import { thresholdHandlers } from './thresholds'

/** Changes of the owner's settings, the profile and sign-in (DESIGN §4.19–4.21). */
export function settingsHandlers(): BoundRoute[] {
  return [
    ...peopleHandlers(),
    ...profileHandlers(),
    ...pagesHandlers(),
    ...tagHandlers(),
    ...thresholdHandlers(),
    ...systemHandlers(),
    ...aiHandlers(),
  ]
}
