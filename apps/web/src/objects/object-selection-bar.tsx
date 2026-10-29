import type { CatalogEntry } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { DownloadButton } from '@contentops/ui/components/download-button'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { CalendarPlusIcon } from 'lucide-react'
import { useRole } from '@/data/session'
import { useObjectDialogs } from './dialogs/use-object-dialogs'
import { downloadOptionsFor } from './download-options'
import { useEntriesMenu } from './entries-menu'
import { PromoMenu } from './promo-menu'
import { useObjectActions } from './use-object-actions'

interface ObjectSelectionBarProps {
  selected: readonly CatalogEntry[]
  /** Подборки модели — для «В промо ▾». */
  collections: readonly CatalogEntry[]
  onClear: () => void
}

/**
 * Полоса выделения объектов Библиотеки (DESIGN §3.3): встаёт на место шапки. «⋯» — тот же
 * список, что у правого клика, без пунктов, стоящих кнопками. «Только чтение» видит число
 * и «⋯», кнопок действий и скачиваний у него нет.
 */
export function ObjectSelectionBar({ selected, collections, onClear }: ObjectSelectionBarProps) {
  const role = useRole()
  const actions = useObjectActions(selected)
  const canAct = role === 'owner' || role === 'manager'
  const dialogs = useObjectDialogs()

  const menu = useEntriesMenu(selected, {
    openDialog: dialogs.open,
    omit: ['open', 'plan', 'download', 'promo'],
  })

  return (
    <>
      <SelectionBar count={selected.length} onClear={onClear} menu={menu}>
        {canAct ? (
          <>
            <Button onClick={actions.planIds}>
              <CalendarPlusIcon />В план
            </Button>
            <DownloadButton
              variant="bar"
              options={downloadOptionsFor(selected)}
              onDownload={actions.download}
            />
            <PromoMenu variant="bar" collections={collections} onAdd={actions.addToPromo} />
          </>
        ) : null}
      </SelectionBar>
      {dialogs.element}
    </>
  )
}
