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

/** «PRM-011, 02.09; PRM-012, 05.09» — where the earlier handoffs came from. */
function sourcesOf(
  members: readonly Pick<CollectionMember, 'handed_to' | 'prepared_for'>[],
  pick: (member: Pick<CollectionMember, 'handed_to' | 'prepared_for'>) => readonly {
    contractor_id: string
    collection_id: ItemId
    on: string
  }[],
  contractorId: string,
) {
  const sources = new Map<ItemId, string>()
  let count = 0
  for (const member of members) {
    const earlier = pick(member).filter((given) => given.contractor_id === contractorId)
    if (earlier.length === 0) continue
    count += 1
    for (const given of earlier) sources.set(given.collection_id, given.on)
  }
  const from = [...sources.entries()].map(([collection_id, on]) => ({ collection_id, on }))
  return { count, from }
}

/**
 * The check before «Подготовить» (DESIGN §4.17): «38 из 100 уже передавали Coraline Red
 * (PRM-011, 02.09)». Earlier handoffs of the same collection count too, so a follow-up
 * handoff does not repeat what already went out. Apart from it, prepared handoffs that
 * nobody marked: «20 из 100 уже в PRM-013 (подготовлена 21.09, «Передано» не нажато)».
 * The server answers it for a whole collection; the screen asks the same rule about a
 * selection inside it.
 */
export function computeHandoffOverlap(
  members: readonly Pick<CollectionMember, 'handed_to' | 'prepared_for'>[],
  contractor: OverlapContractor,
  today: LocalDate,
): HandoffOverlap {
  const sent = sourcesOf(members, (member) => member.handed_to, contractor.id)
  const pending = sourcesOf(members, (member) => member.prepared_for, contractor.id)
  const where = sent.from
    .map((source) => `${source.collection_id}, ${formatDate(source.on, today)}`)
    .join('; ')
  const prepared = pending.from.map(
    (source) => `${source.collection_id} (подготовлена ${formatDate(source.on, today)}`,
  )
  return {
    contractor_id: contractor.id,
    already: sent.count,
    total: members.length,
    from: sent.from,
    text:
      sent.count > 0
        ? `${sent.count} из ${members.length} уже передавали ${contractor.name} (${where})`
        : null,
    pending: pending.count,
    pending_from: pending.from,
    pending_text:
      pending.count > 0
        ? `${pending.count} из ${members.length} уже в ${prepared.join('), ')}, «Передано» не нажато)`
        : null,
  }
}
