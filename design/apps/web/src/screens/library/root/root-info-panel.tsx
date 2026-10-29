import type { CatalogEntry, IntegrationLine, Model, Tag } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { InfoPanel, InfoSection } from '@contentops/ui/components/info-panel'
import type { PageSummariesView } from '@/data/catalog'
import { useRole } from '@/data/session'
import { downloadOptionsFor } from '@/objects/download-options'
import { selectionSummary } from '@/objects/item-facts'
import { PromoMenu } from '@/objects/promo-menu'
import { QuickLook } from '@/objects/quick-look'
import { RecentEvents } from '@/objects/recent-events'
import { useObjectActions } from '@/objects/use-object-actions'
import type { PageNotUploaded } from '../shared/not-uploaded-index'
import type { LibraryFolder } from './library-folders'
import { LibrarySummary } from './library-summary'

interface RootInfoPanelProps {
  model: Model
  selected: readonly CatalogEntry[]
  total: number
  folders: readonly LibraryFolder[]
  notUploaded: readonly PageNotUploaded[] | null
  hubLine: IntegrationLine | null
  summaries: PageSummariesView | undefined
  tags: readonly Tag[] | undefined
  collections: readonly CatalogEntry[]
  width: 'default' | 'narrow'
  onClose: () => void
}

/**
 * Панель сведений корня (DESIGN §3.4): без выделения — что есть у модели; один объект —
 * быстрый взгляд; несколько — сводка выбранного и те же кнопки, что в полосе.
 */
export function RootInfoPanel(props: RootInfoPanelProps) {
  const { selected, onClose, width } = props
  const single = selected.length === 1 ? selected[0] : undefined
  return (
    <InfoPanel
      width={width}
      onClose={onClose}
      tabs={[
        { value: 'details', label: 'Сведения', content: <PanelDetails {...props} /> },
        {
          value: 'history',
          label: 'История',
          content: <RecentEvents item={single?.id} />,
        },
      ]}
    />
  )
}

function PanelDetails({
  model,
  selected,
  total,
  folders,
  notUploaded,
  hubLine,
  summaries,
  tags,
  collections,
}: RootInfoPanelProps) {
  const single = selected.length === 1 ? selected[0] : undefined
  if (single) {
    return <QuickLook entry={single} summaries={summaries?.byItem.get(single.id)} tags={tags} />
  }
  if (selected.length > 1) {
    return <SelectionDetails selected={selected} collections={collections} />
  }
  return (
    <LibrarySummary
      model={model}
      total={total}
      folders={folders}
      notUploaded={notUploaded}
      hubLine={hubLine}
    />
  )
}

function SelectionDetails({
  selected,
  collections,
}: {
  selected: readonly CatalogEntry[]
  collections: readonly CatalogEntry[]
}) {
  const role = useRole()
  const actions = useObjectActions(selected)
  const canAct = role === 'owner' || role === 'manager'
  return (
    <InfoSection title="Выбранное">
      <p>{selectionSummary(selected)}</p>
      {canAct ? (
        <div className="flex flex-wrap gap-2">
          <Button onClick={actions.planIds}>В план</Button>
          <DownloadButton options={downloadOptionsFor(selected)} onDownload={actions.download} />
          <PromoMenu variant="secondary" collections={collections} onAdd={actions.addToPromo} />
        </div>
      ) : null}
    </InfoSection>
  )
}
