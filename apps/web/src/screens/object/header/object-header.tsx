import type { ReactNode } from 'react'
import { useObjectPage } from '../object-context'
import type { FieldSave } from '../panel/markup/use-field-save'
import { IdChip } from './id-chip'
import { ObjectActions } from './object-actions'
import { ObjectCrumbs } from './object-crumbs'
import { ObjectTitle } from './object-title'
import { PpvMark } from './ppv-mark'

interface ObjectHeaderProps {
  info: { open: boolean; onToggle: () => void }
  /** Полоса выделения файлов встаёт на место шапки той же высоты (§3.3). */
  selectionBar?: ReactNode
  /** Сохранение названия: оно же даёт строку конфликта под шапкой. */
  title: FieldSave
}

/**
 * Шапка объекта 72 (DESIGN §4.4): крошки, серый чип ID и название 20/28 с правкой на
 * месте; справа «Скачать ▾», главная кнопка, `ⓘ` и «⋯».
 */
export function ObjectHeader({ info, selectionBar, title }: ObjectHeaderProps) {
  const { detail } = useObjectPage()
  return (
    <header className="group/object-header flex h-18 shrink-0 items-center">
      {/* Полоса без действий (только чтение) возвращает null — тогда шапка остаётся. */}
      {selectionBar ? (
        <div data-slot="selection-bar-slot" className="min-w-0 flex-1 empty:hidden">
          {selectionBar}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-3 duration-120 animate-in fade-in-0 group-has-[[data-slot=selection-bar-slot]:not(:empty)]/object-header:hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          <ObjectCrumbs entry={detail.entry} />
          <div className="flex h-8 min-w-0 items-center gap-2">
            <IdChip id={detail.entry.id} />
            <ObjectTitle field={title} />
            <PpvMark />
          </div>
        </div>
        <ObjectActions info={info} />
      </div>
    </header>
  )
}
