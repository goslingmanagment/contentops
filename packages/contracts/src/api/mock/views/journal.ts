import type { z } from 'zod'
import type { JournalEvent } from '../../../domain/journal'
import type { Page } from '../../../domain/pagination'
import type { Role } from '../../../domain/people'
import type { ModelWorld } from '../../../fixtures/world-types'
import type { JournalQuerySchema } from '../../routes/journal'
import { paginate } from './paginate'

/** Journal with the filters of DESIGN §4.18; «только чтение» does not see orders. */
export function journalPage(
  model: ModelWorld,
  query: z.output<typeof JournalQuerySchema>,
  role: Role,
): Page<JournalEvent> {
  const events = model.journal
    .filter((event) => role !== 'reader' || event.area !== 'orders')
    .filter((event) => !query.actor_type || event.actor.type === query.actor_type)
    .filter((event) => !query.area || event.area === query.area)
    .filter((event) => !query.item || event.item_id === query.item)
    .filter((event) => !query.result || event.result === query.result)
    .filter((event) => !query.from || event.at >= query.from)
    .filter((event) => !query.to || event.at <= query.to)
    .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
  return paginate(events, (event) => event.id, query.cursor, query.limit)
}
