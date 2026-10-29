import {
  type CatalogEntry,
  FAN_NAME_LABEL,
  formatDate,
  formatDuration,
  type ItemId,
  type LocalDate,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@contentops/ui/components/command'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { Thumb } from '@contentops/ui/components/thumb'
import { useEffect, useMemo, useRef } from 'react'
import { useToday } from '@/data/api-session'
import { useCatalogIndex } from '@/data/catalog'
import { itemCover } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'

interface LinkDeliveryPopoverProps {
  /** Уже привязанные сдачи этого заказа — в списке их нет. */
  linked: readonly ItemId[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (item: ItemId) => void
  pending: boolean
}

function facts(entry: CatalogEntry, today: LocalDate): string {
  const parts = [
    entry.duration_s !== null ? formatDuration(entry.duration_s) : null,
    entry.delivered_on ? `сдано ${formatDate(entry.delivered_on, today)}` : null,
    entry.fan_name ? FAN_NAME_LABEL[entry.fan_name] : null,
    entry.order_id ? 'в другом заказе' : null,
  ]
  return parts.filter((part) => part !== null).join(' · ')
}

/**
 * «Привязать сдачу…» (DESIGN §4.16, п. 4): поиск кастома по номеру и названию — для
 * сдачи, которая пришла раньше заказа. Кастомы берутся из индекса модели, без запроса.
 */
export function LinkDeliveryPopover({
  linked,
  open,
  onOpenChange,
  onPick,
  pending,
}: LinkDeliveryPopoverProps) {
  const today = useToday()
  const model = useCurrentModel().code
  const index = useCatalogIndex(model)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Открыто из «⋯» панели: кнопка прокручивается в кадр, чтобы всплывашке было где встать.
  useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  const customs = useMemo(
    () =>
      (index.data?.items ?? [])
        .filter((entry) => entry.type === 'custom' && !linked.includes(entry.id))
        .sort((left, right) => right.arrived_on.localeCompare(left.arrived_on)),
    [index.data, linked],
  )
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm" pending={pending}>
          Привязать сдачу…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-90 gap-0 p-0">
        <Command>
          <CommandInput placeholder="Номер или название кастома" />
          <CommandList className="max-h-80">
            <CommandEmpty>Такого кастома нет</CommandEmpty>
            <CommandGroup>
              {customs.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`${entry.id} ${entry.title}`}
                  onSelect={() => {
                    onPick(entry.id)
                    onOpenChange(false)
                  }}
                  className="gap-3"
                >
                  <Thumb
                    {...itemCover(entry)}
                    showCaptions={false}
                    className="w-7.5 shrink-0 rounded-sm"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">
                      <span className="text-ink-3 tabular-nums">{entry.id}</span> {entry.title}
                    </span>
                    <span className="truncate text-ink-3 text-sm tabular-nums">
                      {facts(entry, today)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
