import type { CatalogEntry, CollectionMember, ItemId, PromoCollection } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { InfoPanel, InfoSection } from '@contentops/ui/components/info-panel'
import { HandoffHistory } from '../handoff/handoff-history'
import { mediaComposition, membersTotals } from '../shared/promo-text'
import { MemberCard } from './member-card'

interface CollectionInfoPanelProps {
  collection: PromoCollection
  selected: readonly CollectionMember[]
  catalog: ReadonlyMap<ItemId, CatalogEntry>
  channelName: (channel: string) => string
  onOpenMember: (member: CollectionMember) => void
  /** `null` — смотрящий не правит. */
  onRemove: ((members: readonly CollectionMember[]) => void) | null
  onOpenHandoff: (handoffId: string) => void
  onClose: () => void
  /** 360, при окне 1280 — 320 (§3.1). */
  width: 'default' | 'narrow'
}

/**
 * Сведения подборки (DESIGN §3.4, §4.17): один материал — его карточка; несколько —
 * «Выбрано 7 · 5 видео · 2 фото · 1,2 ГБ»; ничего — состав и передачи подборки.
 */
export function CollectionInfoPanel({ onClose, width, ...props }: CollectionInfoPanelProps) {
  return (
    <InfoPanel
      tabs={[{ value: 'info', label: 'Сведения', content: <PanelContent {...props} /> }]}
      onClose={onClose}
      width={width}
    />
  )
}

function PanelContent({
  collection,
  selected,
  catalog,
  channelName,
  onOpenMember,
  onRemove,
  onOpenHandoff,
}: Omit<CollectionInfoPanelProps, 'onClose' | 'width'>) {
  const [single] = selected
  if (single && selected.length === 1) {
    return (
      <MemberCard
        member={single}
        catalog={catalog}
        channelName={channelName}
        onOpen={() => onOpenMember(single)}
        onRemove={onRemove ? () => onRemove([single]) : null}
      />
    )
  }
  if (selected.length > 1) {
    return <SelectionSummary selected={selected} onRemove={onRemove} />
  }
  return (
    <>
      <InfoSection title={collection.id}>
        <p className="text-base">{collection.title}</p>
        <p className="text-muted-foreground text-sm tabular-nums">{mediaComposition(collection)}</p>
      </InfoSection>
      <HandoffHistory handoffs={collection.handoffs} currentId={null} onPick={onOpenHandoff} />
    </>
  )
}

function SelectionSummary({
  selected,
  onRemove,
}: {
  selected: readonly CollectionMember[]
  onRemove: CollectionInfoPanelProps['onRemove']
}) {
  return (
    <InfoSection title={`Выбрано ${selected.length}`}>
      <p className="text-base tabular-nums">{mediaComposition(membersTotals(selected))}</p>
      {onRemove ? (
        <Button variant="outline" className="self-start" onClick={() => onRemove(selected)}>
          Убрать из подборки
        </Button>
      ) : null}
    </InfoSection>
  )
}
