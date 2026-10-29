import { ITEM_TYPE_INFO } from '@contentops/contracts'
import { Kbd } from '@contentops/ui/components/kbd'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { SearchIcon } from 'lucide-react'
import { timelineTimecode } from '@/data/search'
import { itemCover } from '@/lib/item-cover'
import { destinationIcon } from '../navigation/icons'
import type { Suggestion } from './search-suggestions'

interface SuggestionRowProps {
  id: string
  suggestion: Suggestion
  active: boolean
  onActivate: () => void
  onHover: () => void
}

/** Строка подсказки: объект с миниатюрой, минута хронологии, раздел или «Все результаты». */
export function SuggestionRow({ id, suggestion, active, onActivate, onHover }: SuggestionRowProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши обрабатывает поле поиска (aria-activedescendant)
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
      className={cn(
        'flex min-h-10 cursor-default items-center gap-3 rounded-lg px-3 py-1.5 text-base transition-colors duration-120',
        active && 'bg-accent',
      )}
    >
      <SuggestionBody suggestion={suggestion} />
    </div>
  )
}

function SuggestionBody({ suggestion }: { suggestion: Suggestion }) {
  switch (suggestion.kind) {
    case 'item': {
      const { entry, exact } = suggestion
      return (
        <>
          <Thumb {...itemCover(entry)} showCaptions={false} className="w-7.5 shrink-0 rounded-md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{entry.title}</span>
            <span className="truncate text-ink-3 text-sm tabular-nums">
              {entry.id} · {ITEM_TYPE_INFO[entry.type].folder}
            </span>
          </span>
          {exact ? <Kbd>Enter</Kbd> : null}
        </>
      )
    }
    case 'timeline': {
      const { hit, entry } = suggestion
      return (
        <>
          {entry ? (
            <Thumb
              {...itemCover(entry)}
              showCaptions={false}
              className="w-7.5 shrink-0 rounded-md"
            />
          ) : (
            <span className="w-7.5 shrink-0" />
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate tabular-nums">
              {hit.item_id} · {timelineTimecode(hit.t_s)} — {hit.label}
            </span>
            {entry ? <span className="truncate text-ink-3 text-sm">{entry.title}</span> : null}
          </span>
        </>
      )
    }
    case 'destination': {
      const { destination } = suggestion
      const Icon = destinationIcon(destination.destination)
      return (
        <>
          <span className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4 text-ink-3" />
          </span>
          <span className="min-w-0 flex-1 truncate">{destination.label}</span>
          <span className="shrink-0 text-ink-3 text-sm">{destination.place}</span>
        </>
      )
    }
    case 'all':
      return (
        <>
          <span className="flex h-7.5 w-7.5 shrink-0 items-center justify-center">
            <SearchIcon className="size-4 text-ink-3" />
          </span>
          <span className="min-w-0 flex-1 truncate">Все результаты по «{suggestion.query}»</span>
        </>
      )
  }
}
