import { ConflictLine } from '@contentops/ui/components/state-lines'
import { QueryErrorLine, type QueryErrorSource } from '@/shell/field/query-error-line'
import { RefreshStrip } from '@/shell/field/refresh-strip'
import { useFileSelection } from '../files/file-selection'
import { FileSelectionBar } from '../files/file-selection-bar'
import { useFieldSave } from '../panel/markup/use-field-save'
import { ObjectHeader } from './object-header'
import { ObjectSummary } from './object-summary'

interface ObjectTopProps {
  info: { open: boolean; onToggle: () => void }
  refreshing: boolean
  /** Чтение объекта: ошибка обновления — строка над прежними данными. */
  query: QueryErrorSource
}

/**
 * Верх объекта над файлами (DESIGN §3.10, §4.4): шапка или полоса выделения, полоска
 * фонового обновления, строки ошибки и конфликта названия, мета-строка и «где залито».
 */
export function ObjectTop({ info, refreshing, query }: ObjectTopProps) {
  const selection = useFileSelection()
  const title = useFieldSave('title')
  return (
    <>
      <ObjectHeader
        info={info}
        title={title}
        selectionBar={selection.keys.size > 0 ? <FileSelectionBar /> : undefined}
      />
      <RefreshStrip active={refreshing} />
      <QueryErrorLine query={query} />
      {title.conflict ? (
        <ConflictLine
          message={title.conflict.message}
          onShowTheirs={title.showTheirs}
          onKeepMine={() => void title.keepMine()}
          className="mb-2"
        />
      ) : null}
      <ObjectSummary />
    </>
  )
}
