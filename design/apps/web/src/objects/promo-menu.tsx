import type { CatalogEntry, ItemId } from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { ChevronDownIcon, MegaphoneIcon, PlusIcon } from 'lucide-react'
import { usePromoChannels } from '@/data/promo'
import { useCurrentModel } from '@/shell/model/model-context'

const COLLECTIONS_IN_MENU = 6

interface PromoMenuProps {
  /** Подборки модели из индекса: по ним строится подменю канала. */
  collections: readonly CatalogEntry[]
  onAdd: (channel: string, collection: ItemId | 'new') => void
  variant: 'bar' | 'secondary'
}

/** «В промо ▾ → канал → подборка» (DESIGN §2.5): ссылками, без копий файлов. */
export function PromoMenu({ collections, onAdd, variant }: PromoMenuProps) {
  const model = useCurrentModel().code
  const channels = usePromoChannels(model).data ?? []
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant}>
          <MegaphoneIcon />В промо
          <ChevronDownIcon className="-mr-1 size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Канал</DropdownMenuLabel>
        {channels.map((channel) => {
          const inChannel = collections
            .filter((entry) => entry.channel === channel.id)
            .slice(0, COLLECTIONS_IN_MENU)
          return (
            <DropdownMenuSub key={channel.id}>
              <DropdownMenuSubTrigger>{channel.name}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuItem onSelect={() => onAdd(channel.id, 'new')}>
                  <PlusIcon />
                  Новая подборка
                </DropdownMenuItem>
                {inChannel.length > 0 ? <DropdownMenuSeparator /> : null}
                {inChannel.map((entry) => (
                  <DropdownMenuItem key={entry.id} onSelect={() => onAdd(channel.id, entry.id)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{entry.title}</span>
                      <span className="text-ink-3 text-sm tabular-nums">{entry.id}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
