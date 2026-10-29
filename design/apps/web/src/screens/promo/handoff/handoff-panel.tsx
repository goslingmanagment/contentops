import type { PromoCollection } from '@contentops/contracts'
import type { PanelFrameWidth } from '@contentops/ui/components/panel-frame'
import { HandoffFormPanel } from './handoff-form-panel'
import { HandoffHistory } from './handoff-history'
import { type HandoffPanelState, handoffToShow } from './handoff-panel-state'
import { HandoffStatePanel } from './handoff-state-panel'

interface HandoffPanelProps {
  collection: PromoCollection
  state: HandoffPanelState
  onStateChange: (next: HandoffPanelState) => void
  onClose: () => void
  width: PanelFrameWidth
}

/**
 * Передача в правой панели 400 (DESIGN §4.17): шаг 1 — подрядчик и «Подготовить»,
 * шаг 2 — ход сборки, ZIP, сводка и «Передано». Можно уйти: ход виден в лотке, а панель
 * вернётся вместе с записью истории.
 */
export function HandoffPanel({
  collection,
  state,
  onStateChange,
  onClose,
  width,
}: HandoffPanelProps) {
  const handoff = handoffToShow(state, collection.handoffs)
  const showHandoff = (id: string) => onStateChange({ show: 'handoff', id })
  const history = (
    <HandoffHistory
      handoffs={collection.handoffs}
      currentId={handoff?.id ?? null}
      onPick={showHandoff}
    />
  )
  if (!handoff) {
    return (
      <HandoffFormPanel
        key={collection.id}
        collection={collection}
        only={state.show === 'new' ? (state.members ?? null) : null}
        onStarted={showHandoff}
        onClose={onClose}
        width={width}
        history={history}
      />
    )
  }
  return (
    <HandoffStatePanel
      collection={collection}
      handoff={handoff}
      onNew={() => onStateChange({ show: 'new' })}
      onStarted={showHandoff}
      onClose={onClose}
      width={width}
      history={history}
    />
  )
}
