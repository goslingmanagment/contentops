import type { CatalogEntry, PageSummaryEntry, Tag } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { InfoPanel, InfoSection } from '@contentops/ui/components/info-panel'
import type { ReactNode } from 'react'
import type { PageSummariesView } from '@/data/catalog'
import { useRole } from '@/data/session'
import { downloadOptionsFor } from '@/objects/download-options'
import { selectionSummary } from '@/objects/item-facts'
import { PromoMenu } from '@/objects/promo-menu'
import { QuickLook } from '@/objects/quick-look'
import { RecentEvents } from '@/objects/recent-events'
import { useObjectActions } from '@/objects/use-object-actions'

interface ObjectsInfoPanelProps {
  selected: readonly CatalogEntry[]
  summaries: PageSummariesView | undefined
  tags: readonly Tag[] | undefined
  collections: readonly CatalogEntry[]
  width: 'default' | 'narrow'
  onClose: () => void
  /** Без выделения: что в разделе или на странице. */
  summary: ReactNode
  /** Кнопки для нескольких выбранных — те же, что в полосе; по умолчанию как в Библиотеке. */
  selectionActions?: (selected: readonly CatalogEntry[]) => ReactNode
}

/**
 * Панель сведений списков Библиотеки (DESIGN §3.4): один объект — быстрый взгляд, не
 * открывая объект; несколько — сводка выбранного и те же кнопки, что в полосе; без
 * выделения — сводка раздела.
 */
export function ObjectsInfoPanel(props: ObjectsInfoPanelProps) {
  const { selected, width, onClose } = props
  const single = selected.length === 1 ? selected[0] : undefined
  return (
    <InfoPanel
      width={width}
      onClose={onClose}
      tabs={[
        { value: 'details', label: 'Сведения', content: <PanelDetails {...props} /> },
        { value: 'history', label: 'История', content: <RecentEvents item={single?.id} /> },
      ]}
    />
  )
}

function PanelDetails({
  selected,
  summaries,
  tags,
  collections,
  summary,
  selectionActions,
}: ObjectsInfoPanelProps) {
  const single = selected.length === 1 ? selected[0] : undefined
  if (single) {
    return <QuickLook entry={single} summaries={pageSummariesOf(summaries, single)} tags={tags} />
  }
  if (selected.length > 1) {
    return (
      <InfoSection title="Выбранное">
        <p>{selectionSummary(selected)}</p>
        {selectionActions ? (
          selectionActions(selected)
        ) : (
          <LibraryActions selected={selected} collections={collections} />
        )}
      </InfoSection>
    )
  }
  return summary
}

function pageSummariesOf(
  summaries: PageSummariesView | undefined,
  entry: CatalogEntry,
): readonly PageSummaryEntry[] | undefined {
  return summaries?.byItem.get(entry.id)
}

function LibraryActions({
  selected,
  collections,
}: {
  selected: readonly CatalogEntry[]
  collections: readonly CatalogEntry[]
}) {
  const role = useRole()
  const actions = useObjectActions(selected)
  if (role !== 'owner' && role !== 'manager') {
    return null
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={actions.planIds}>В план</Button>
      <DownloadButton options={downloadOptionsFor(selected)} onDownload={actions.download} />
      <PromoMenu variant="secondary" collections={collections} onAdd={actions.addToPromo} />
    </div>
  )
}
