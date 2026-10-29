import type {
  CatalogEntry,
  CheckCase,
  ItemId,
  LocalDate,
  PersonRef,
  PlanRow,
  Release,
} from '@contentops/contracts'
import { InfoPanel } from '@contentops/ui/components/info-panel'
import type { ReactNode } from 'react'
import { RecentEvents } from '@/objects/recent-events'
import type { RowEditMode } from '../row-menu'
import { RowDetails, type RowDetailsHandlers } from './row-details'
import { RowEdit } from './row-edit'
import { SelectionDetails } from './selection-details'

export interface PanelEdit {
  mode: RowEditMode
  rowIds: readonly string[]
}

interface PlanPanelProps extends RowDetailsHandlers {
  /** Выбранные строки: одна — рабочее место строки, несколько — сводка выбранного. */
  rows: readonly PlanRow[]
  /** Без выделения: что в дне или неделе. */
  empty: ReactNode
  catalog: ReadonlyMap<ItemId, CatalogEntry> | undefined
  checkCases: readonly CheckCase[]
  releases: readonly Release[]
  people: readonly PersonRef[]
  today: LocalDate
  canAct: boolean
  edit: PanelEdit | null
  onEditChange: (edit: PanelEdit | null) => void
  width: 'default' | 'narrow'
  onClose: () => void
}

/**
 * Панель сведений Плана (DESIGN §3.4, §4.11): одна строка — превью, главная кнопка,
 * «Как дела», пара для ◆, файлы для страницы, выпуск; несколько — сводка и те же
 * кнопки, что в полосе; ничего — сводка дня или недели.
 */
export function PlanPanel(props: PlanPanelProps) {
  const { rows, onClose, width } = props
  const single = rows.length === 1 ? rows[0] : undefined
  return (
    <InfoPanel
      width={width}
      onClose={onClose}
      tabs={[
        { value: 'details', label: 'Сведения', content: <PanelContent {...props} /> },
        {
          value: 'history',
          label: 'История',
          content: <RecentEvents item={single?.manifest?.item_id} />,
        },
      ]}
    />
  )
}

function PanelContent(props: PlanPanelProps) {
  const { rows, edit, people, today, onEditChange, empty } = props
  const editRows = edit ? rows.filter((row) => edit.rowIds.includes(row.id)) : []
  const editor =
    edit && editRows.length > 0 ? (
      <RowEdit
        rows={editRows}
        mode={edit.mode}
        today={today}
        people={people}
        onDone={() => onEditChange(null)}
      />
    ) : null
  const single = rows.length === 1 ? rows[0] : undefined
  if (single) {
    return (
      <RowDetails
        {...props}
        row={single}
        entry={single.manifest ? props.catalog?.get(single.manifest.item_id) : undefined}
        checkCase={props.checkCases.find((candidate) => candidate.plan_row_id === single.id)}
        release={props.releases.find((candidate) => candidate.id === single.release_id)}
        editor={editor}
      />
    )
  }
  if (rows.length > 1) {
    return (
      <>
        {editor}
        <SelectionDetails rows={rows} />
      </>
    )
  }
  return empty
}
