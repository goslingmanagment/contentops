import type { ChannelContents, ItemId } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { SelectionBar } from '@contentops/ui/components/selection-bar'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'

type CollectionSummary = ChannelContents['collections'][number]

interface UnfiledSelectionBarProps {
  count: number
  collections: readonly CollectionSummary[]
  /** `null` — смотрящий не правит: в полосе только число. */
  onPrepare: (() => void) | null
  onFile: (collection: ItemId | 'new') => void
  busy: boolean
  onClear: () => void
}

/**
 * Полоса выбора среди материалов канала (DESIGN §3.3): «Подготовить передачу» сначала
 * заводит новую подборку из выбранного, «В подборку ▾» — существующая или новая.
 */
export function UnfiledSelectionBar({
  count,
  collections,
  onPrepare,
  onFile,
  busy,
  onClear,
}: UnfiledSelectionBarProps) {
  return (
    <SelectionBar count={count} onClear={onClear}>
      {onPrepare ? (
        <>
          <Button onClick={onPrepare} aria-busy={busy || undefined}>
            {busy ? '…' : 'Подготовить передачу'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="bar">
                В подборку
                <ChevronDownIcon className="-mr-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuItem onSelect={() => onFile('new')}>
                <PlusIcon />
                Новая подборка
              </DropdownMenuItem>
              {collections.length > 0 ? <DropdownMenuSeparator /> : null}
              {collections.map((collection) => (
                <DropdownMenuItem key={collection.id} onSelect={() => onFile(collection.id)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{collection.title}</span>
                    <span className="text-ink-3 text-sm tabular-nums">{collection.id}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </SelectionBar>
  )
}
