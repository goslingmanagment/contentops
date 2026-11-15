import { adminRoutes } from './admin'
import { checkRoutes } from './check'
import { hubOrderRoutes } from './hub-orders'
import { inboxRoutes, legacyRoutes } from './inbox'
import { journalRoutes, operationRoutes } from './journal'
import { markupRoutes } from './markup'
import { mediaRoutes } from './media'
import { objectBatchRoutes, objectFileRoutes } from './object-files'
import { objectRoutes } from './objects'
import { orderRoutes } from './orders'
import { planRoutes } from './plan'
import { promoRoutes } from './promo'
import { publicationRoutes } from './publications'
import { authRoutes, settingsRoutes } from './settings'
import { shootingTaskRoutes } from './shooting'
import { statsRoutes } from './stats'
import { waitingRoutes } from './waiting'

/** Every route of API v1 by area; the client and the mock read from here. */
export const apiRoutes = {
  admin: adminRoutes,
  objects: objectRoutes,
  objectFiles: objectFileRoutes,
  objectBatch: objectBatchRoutes,
  markup: markupRoutes,
  inbox: inboxRoutes,
  legacy: legacyRoutes,
  plan: planRoutes,
  check: checkRoutes,
  orders: orderRoutes,
  hubOrders: hubOrderRoutes,
  shootingTasks: shootingTaskRoutes,
  waiting: waitingRoutes,
  publications: publicationRoutes,
  stats: statsRoutes,
  promo: promoRoutes,
  journal: journalRoutes,
  operations: operationRoutes,
  media: mediaRoutes,
  settings: settingsRoutes,
  auth: authRoutes,
}

export type ApiRoutes = typeof apiRoutes
