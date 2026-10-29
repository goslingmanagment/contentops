import type { CatalogEntry } from '@contentops/contracts'
import { ItemContextMenu } from '@contentops/ui/components/item-menu'
import { type ReactElement, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useObjectDialogs } from '@/objects/dialogs/use-object-dialogs'
import { useEntriesMenu } from '@/objects/entries-menu'
import type { PlanDialogPreset } from '@/shell/dialogs/plan-dialog-context'

interface EntryContextMenuProps {
  /** Объекты списка: по ним находится тот, на котором нажали правую кнопку. */
  entries: readonly CatalogEntry[]
  selectedKeys: ReadonlySet<string>
  onSelectedKeysChange: (next: Set<string>) => void
  /** Сам список; у объектов в нём атрибут `data-entry-id`. */
  children: ReactElement
  /** Что подставить в окно «В план»: «Ещё не залито» подставляет страницу и место. */
  planPreset?: (entries: readonly CatalogEntry[]) => PlanDialogPreset
}

function entryIdAt(event: Event): string | null {
  return event.target instanceof Element
    ? (event.target.closest('[data-entry-id]')?.getAttribute('data-entry-id') ?? null)
    : null
}

/**
 * Правый клик по объекту списка (DESIGN §3.6): полный список пунктов объекта — тот же,
 * что в «⋯» полосы выделения, плюс то, что там стоит кнопками. Если объект не был
 * выделен, выделяется он один, как у Я.Диска; действие идёт на всё выделенное.
 */
export function EntryContextMenu({
  entries,
  selectedKeys,
  onSelectedKeysChange,
  children,
  planPreset,
}: EntryContextMenuProps) {
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries])
  const [targets, setTargets] = useState<readonly CatalogEntry[]>([])
  const dialogs = useObjectDialogs()
  const menu = useEntriesMenu(targets, { openDialog: dialogs.open, planPreset })

  // Слушатель на погружении: успевает выбрать объект до того, как меню откроется, и
  // не даёт открыть пустое меню на свободном месте списка.
  const onContextMenu = useEffectEvent((event: Event) => {
    const id = entryIdAt(event)
    const entry = id ? byId.get(id) : undefined
    if (!entry) {
      event.preventDefault()
      return
    }
    if (selectedKeys.has(entry.id)) {
      setTargets(entries.filter((candidate) => selectedKeys.has(candidate.id)))
    } else {
      onSelectedKeysChange(new Set([entry.id]))
      setTargets([entry])
    }
  })
  const areaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const area = areaRef.current
    const listener = (event: Event) => onContextMenu(event)
    area?.addEventListener('contextmenu', listener, { capture: true })
    return () => area?.removeEventListener('contextmenu', listener, { capture: true })
  }, [])

  return (
    <>
      <ItemContextMenu menu={menu}>
        <div ref={areaRef} className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </ItemContextMenu>
      {dialogs.element}
    </>
  )
}
