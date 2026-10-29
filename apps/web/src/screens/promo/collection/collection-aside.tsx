import type { PromoCollection } from '@contentops/contracts'
import type { ComponentProps } from 'react'
import { HandoffPanel } from '../handoff/handoff-panel'
import type { HandoffPanelState } from '../handoff/handoff-panel-state'
import { CollectionInfoPanel } from './collection-info-panel'

interface CollectionAsideProps {
  collection: PromoCollection
  handoffPanel: HandoffPanelState | null
  onHandoffPanelChange: (next: HandoffPanelState | null) => void
  infoOpen: boolean
  info: ComponentProps<typeof CollectionInfoPanel>
  narrow: boolean
}

/** Справа — передача, если она открыта, иначе сведения, если включена «ⓘ». */
export function CollectionAside({
  collection,
  handoffPanel,
  onHandoffPanelChange,
  infoOpen,
  info,
  narrow,
}: CollectionAsideProps) {
  if (handoffPanel) {
    return (
      <HandoffPanel
        collection={collection}
        state={handoffPanel}
        onStateChange={onHandoffPanelChange}
        onClose={() => onHandoffPanelChange(null)}
        width={narrow ? 'narrow' : 'wide'}
      />
    )
  }
  return infoOpen ? <CollectionInfoPanel {...info} /> : null
}
