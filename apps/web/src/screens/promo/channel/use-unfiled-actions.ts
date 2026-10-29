import { formatDayMonthWords, type ItemId, mskDate } from '@contentops/contracts'
import { useClock } from '@/data/api-session'
import { useOpenCollection } from '../shared/promo-links'
import type { useMemberSelection } from '../shared/use-member-selection'
import { usePromoActions } from '../shared/use-promo-actions'

type MemberSelection = ReturnType<typeof useMemberSelection>

/**
 * Что делать с выбором «Без подборки» (DESIGN §4.17): положить в подборку или сразу
 * подготовить передачу — тогда сначала заводится новая подборка и открывается её панель.
 */
export function useUnfiledActions(
  channel: string,
  channelName: string,
  selection: MemberSelection,
) {
  const actions = usePromoActions()
  const clock = useClock()
  const openCollection = useOpenCollection()
  const members = selection.selected.map(({ item_id, file_key }) => ({ item_id, file_key }))
  // Новая подборка названа по каналу и дню, как прежние («Instagram, май»).
  const title = `${channelName}, ${formatDayMonthWords(mskDate(clock.now()))}`

  const file = (collection: ItemId | 'new') =>
    actions.add({ channel, collection, title, members, onAdded: selection.clear })
  const prepare = () =>
    actions.add({
      channel,
      collection: 'new',
      title,
      members,
      onAdded: (created) => {
        selection.clear()
        openCollection(channel, created.id, { show: 'current' })
      },
    })
  return { file, prepare, busy: actions.adding }
}
