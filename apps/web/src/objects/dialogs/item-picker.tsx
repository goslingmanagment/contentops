import { type CatalogEntry, formatNumber, type ItemId } from '@contentops/contracts'
import { Input } from '@contentops/ui/components/input'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { SearchIcon } from 'lucide-react'
import { type KeyboardEvent, useId, useMemo, useState } from 'react'
import { useEntriesSearch } from '@/data/catalog-search'
import { itemCover } from '@/lib/item-cover'
import { lengthText } from '../item-facts'

const VISIBLE_LIMIT = 40

interface ItemPickerProps {
  /** Из чего выбирать: уже отфильтровано по смыслу окна (сырьё, не сам объект). */
  entries: readonly CatalogEntry[]
  value: ItemId | null
  onChange: (id: ItemId) => void
  /** Подпись поиска: «Найти съёмку», «Найти объект». */
  label: string
  className?: string
}

/**
 * Выбор объекта из индекса в окне (DESIGN §3.13): тот же разбор запроса, что у верхней
 * строки поиска, — ID в любом виде, формы слов, слова-типы; работает без запроса.
 * Строка 52 с миниатюрой 40, стрелки двигают выбор.
 */
export function ItemPicker({ entries, value, onChange, label, className }: ItemPickerProps) {
  const [query, setQuery] = useState('')
  const listId = useId()
  const searched = useEntriesSearch(entries, query)
  const found = useMemo(() => searched.slice(0, VISIBLE_LIMIT), [searched])
  const current = found.findIndex((entry) => entry.id === value)

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    const next = found[Math.min(found.length - 1, Math.max(0, current + step))]
    if (step !== 0 && next) {
      event.preventDefault()
      onChange(next.id)
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-ink-3" />
        <Input
          role="combobox"
          aria-label={label}
          aria-controls={listId}
          aria-expanded
          aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
          placeholder={label}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          className="pl-9"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={label}
        className="flex max-h-72 min-h-0 flex-col overflow-y-auto"
      >
        {found.length === 0 ? (
          <p className="px-2 py-3 text-muted-foreground">Ничего не нашлось</p>
        ) : null}
        {found.map((entry, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши обрабатывает поле поиска (aria-activedescendant)
          <div
            key={entry.id}
            id={`${listId}-${index}`}
            role="option"
            tabIndex={-1}
            aria-selected={entry.id === value}
            onClick={() => onChange(entry.id)}
            className="flex h-13 shrink-0 cursor-pointer items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent aria-selected:bg-primary-tint"
          >
            <Thumb {...itemCover(entry)} showCaptions={false} className="w-8 rounded-md" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{entry.title}</span>
              <span className="text-ink-3 text-sm tabular-nums">
                {entry.id} · {lengthText(entry)}
              </span>
            </span>
          </div>
        ))}
        {entries.length > VISIBLE_LIMIT && found.length === VISIBLE_LIMIT ? (
          <p className="px-2 py-2 text-ink-3 text-sm">
            Показаны первые {formatNumber(VISIBLE_LIMIT)} — уточните поиск
          </p>
        ) : null}
      </div>
    </div>
  )
}
