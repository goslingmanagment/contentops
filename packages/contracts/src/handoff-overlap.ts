import type { LocalDate } from './domain/common'
import type { ItemId } from './domain/item-type'
import type { CollectionMember, HandoffOverlap } from './domain/promo'
import { formatDate } from './format'

export interface OverlapContractor {
  id: string
  name: string
}

/** Was the material already handed to this contractor, from any collection? */
export function handedTo(member: Pick<CollectionMember, 'handed_to'>, contractorId: string) {
  return member.handed_to.some((given) => given.contractor_id === contractorId)
}

/**
 * The check before «Подготовить» (DESIGN §4.17): «38 из 100 уже передавали Coraline Red
 * (PRM-011, 02.09)». Earlier handoffs of the same collection count too, so a follow-up
 * handoff does not repeat what already went out. The server answers it for a whole
 * collection; the screen asks the same rule about a selection inside it.
 */
export function computeHandoffOverlap(
  members: readonly Pick<CollectionMember, 'handed_to'>[],
  contractor: OverlapContractor,
  today: LocalDate,
): HandoffOverlap {
  const sources = new Map<ItemId, string>()
  let already = 0
  for (const member of members) {
    const earlier = member.handed_to.filter((given) => given.contractor_id === contractor.id)
    if (earlier.length === 0) continue
    already += 1
    for (const given of earlier) sources.set(given.collection_id, given.on)
  }
  const from = [...sources.entries()].map(([collection_id, on]) => ({ collection_id, on }))
  const where = from
    .map((source) => `${source.collection_id}, ${formatDate(source.on, today)}`)
    .join('; ')
  return {
    contractor_id: contractor.id,
    already,
    total: members.length,
    from,
    text:
      already > 0
        ? `${already} из ${members.length} уже передавали ${contractor.name} (${where})`
        : null,
  }
}
