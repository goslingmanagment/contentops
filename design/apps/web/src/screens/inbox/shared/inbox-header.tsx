import { FieldHeader } from '@contentops/ui/components/field-header'
import type { ObjectTileView } from '@contentops/ui/components/object-tile'
import type { ReactNode } from 'react'
import { type InboxTab, InboxTabs } from './inbox-tabs'

interface InboxHeaderProps {
  active: InboxTab
  /** Справа серым: «Я.Диск проверен 4 мин назад» или строка интеграции; сжимается первой. */
  aside?: ReactNode
  view?: { value: ObjectTileView; onChange: (view: ObjectTileView) => void }
  selectionBar?: ReactNode
}

/** Вид «Нового»: крупная плитка или список (DESIGN §4.8). */
const INBOX_VIEWS: readonly ObjectTileView[] = ['large', 'row']

/**
 * Шапка «Приехало» (DESIGN §4.8): заголовок и сразу за ним вкладки, справа — Я.Диск и
 * вид. Полоса выделения встаёт на место шапки той же высоты (§3.3).
 */
export function InboxHeader({ active, aside, view, selectionBar }: InboxHeaderProps) {
  return (
    <FieldHeader
      title="Приехало"
      nav={<InboxTabs active={active} />}
      note={aside}
      view={view ? { ...view, options: INBOX_VIEWS } : undefined}
      selectionBar={selectionBar}
    />
  )
}
