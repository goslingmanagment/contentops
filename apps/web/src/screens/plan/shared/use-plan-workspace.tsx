import type { LocalDate, PersonRef, PlanRow, Release } from '@contentops/contracts'
import { type ReactNode, useState } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { useCheckList } from '@/data/check'
import { useInfoPanel } from '@/shell/field/use-info-panel'
import { useCurrentModel } from '@/shell/model/model-context'
import { type PanelEdit, PlanPanel } from './panel/plan-panel'
import { RowsSelectionBar } from './rows-selection-bar'
import { useRowMenus } from './use-row-menus'
import { useRowUpload } from './use-row-upload'

interface WorkspaceOptions {
  /** Под каким ключом запоминается, открыта ли панель: у дня и недели — свой. */
  panelKey: 'plan-day' | 'plan-week'
  selectedRows: readonly PlanRow[]
  releases: readonly Release[]
  selectRows: (rowIds: readonly string[]) => void
  clearSelection: () => void
  canAct: boolean
}

interface AsideProps {
  /** Панель без выделения: сводка дня или недели. */
  empty: ReactNode
  people: readonly PersonRef[]
  today: LocalDate
}

/**
 * Общее у дня и недели (DESIGN §3.3–3.4, §4.11–4.12): панель строки с правкой в ней,
 * меню строки, цель загрузки и полоса выделения — одни и те же для обоих видов.
 */
export function usePlanWorkspace({
  panelKey,
  selectedRows,
  releases,
  selectRows,
  clearSelection,
  canAct,
}: WorkspaceOptions) {
  const model = useCurrentModel()
  const panel = useInfoPanel(panelKey)
  const catalog = useCatalogIndex(model.code)
  const check = useCheckList(model.code)
  const [edit, setEdit] = useState<PanelEdit | null>(null)
  const single = selectedRows.length === 1 ? (selectedRows[0] ?? null) : null
  const upload = useRowUpload(single)
  const release =
    releases.find(
      (candidate) =>
        selectedRows.length > 0 && selectedRows.every((row) => row.release_id === candidate.id),
    ) ?? null

  const showPanel = () => {
    if (!panel.open) {
      panel.toggle()
    }
  }
  const openRows = (rows: readonly PlanRow[]) => {
    selectRows(rows.map((row) => row.id))
    showPanel()
  }
  const editRows = (rows: readonly PlanRow[], mode: PanelEdit['mode']) => {
    openRows(rows)
    setEdit({ mode, rowIds: rows.map((row) => row.id) })
  }
  const menuFor = useRowMenus({ canAct, onEdit: (row, mode) => editRows([row], mode) })

  const aside = ({ empty, people, today }: AsideProps) =>
    panel.open ? (
      <PlanPanel
        rows={selectedRows}
        empty={empty}
        catalog={catalog.data?.byId}
        checkCases={check.data?.items ?? []}
        releases={releases}
        people={people}
        today={today}
        canAct={canAct}
        edit={edit}
        onEditChange={setEdit}
        menuFor={menuFor}
        onUploadMontage={upload.uploadFor}
        onSelectRelease={(chosen) => selectRows(chosen.row_ids)}
        width={panel.width}
        onClose={panel.close}
      />
    ) : null

  const selectionBar =
    selectedRows.length > 0 && canAct ? (
      <RowsSelectionBar
        rows={selectedRows}
        release={release}
        onClear={clearSelection}
        onEdit={(mode) => editRows(selectedRows, mode)}
        onShowFailed={selectRows}
        compact={panel.open}
      />
    ) : undefined

  return {
    panel,
    info: { open: panel.open, onToggle: panel.toggle },
    upload,
    menuFor,
    openRows,
    /** Новое выделение закрывает правку прежней строки. */
    stopEditing: () => setEdit(null),
    aside,
    selectionBar,
  }
}
