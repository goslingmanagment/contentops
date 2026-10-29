import type { ModelCode } from '@contentops/contracts'
import { Kbd } from '@contentops/ui/components/kbd'
import { cn } from '@contentops/ui/lib/utils'
import { useNavigate } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { type KeyboardEvent, useDeferredValue, useId, useMemo, useRef, useState } from 'react'
import { useFoundObjects } from '@/data/search'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import { useGoTo } from '../navigation/use-go-to'
import { buildSuggestions, type Suggestion } from './search-suggestions'
import { SuggestionRow } from './suggestion-row'
import { useOpenSearch } from './use-open-search'

const PLACEHOLDER = 'Найти: ппв 73, кастом в колготках, фуп у зеркала…'

/**
 * Поиск в верхней полосе (DESIGN §2.1, §4.7): `/` и `Ctrl K` ставят в него фокус.
 * Подсказки — тот же поиск, что у страницы результатов: объекты сразу из индекса,
 * хронология — когда ответит сервер. `Enter` по точному ID открывает объект, по имени
 * раздела — раздел, по минуте, которая отвечает на запрос целиком, — просмотр с неё,
 * иначе — экран поиска с запросом в `history.state`.
 */
export function TopSearch({ model }: { model: ModelCode }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const deferredQuery = useDeferredValue(query)

  const { index, server, found } = useFoundObjects(model, deferredQuery)
  const { groups, activeKey } = useMemo(
    () =>
      buildSuggestions(deferredQuery, {
        index: index.data,
        found,
        timeline: server.data?.timeline ?? [],
      }),
    [deferredQuery, index.data, found, server.data],
  )
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const defaultIndex = flat.findIndex((item) => item.key === activeKey)
  const current = activeIndex >= 0 ? activeIndex : defaultIndex

  const { goToObject, goToDestination } = useGoTo()
  const navigate = useNavigate()
  const openSearch = useOpenSearch()

  const focusSearch = () => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }
  useKeyboardShortcut({ code: 'Slash' }, focusSearch)
  useKeyboardShortcut({ code: 'KeyK', modifier: true, whileTyping: true }, focusSearch)

  const close = () => {
    setOpen(false)
    setActiveIndex(-1)
  }

  const activate = (suggestion: Suggestion | undefined) => {
    const text = query.trim()
    if (!suggestion) {
      if (text) {
        openSearch(model, text)
      }
    } else if (suggestion.kind === 'item') {
      goToObject(model, suggestion.entry.id)
    } else if (suggestion.kind === 'timeline') {
      void navigate({
        to: '/$model/i/$id',
        params: { model, id: suggestion.hit.item_id },
        search: { view: 'master', t: suggestion.hit.t_s },
      })
    } else if (suggestion.kind === 'destination') {
      goToDestination(model, suggestion.destination.destination)
    } else {
      openSearch(model, suggestion.query)
    }
    close()
    inputRef.current?.blur()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      if (flat.length === 0) {
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      const start = current < 0 ? (step > 0 ? -1 : 0) : current
      setActiveIndex((start + step + flat.length) % flat.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      activate(current >= 0 ? flat[current] : undefined)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (open && query) {
        close()
      } else {
        inputRef.current?.blur()
      }
    }
  }

  const expanded = open && query.trim().length > 0 && flat.length > 0
  const optionId = (position: number) => `${listId}-${position}`

  return (
    <div className="relative w-140 max-w-full">
      <div
        className={cn(
          'flex h-11 items-center gap-3 rounded-xl bg-background px-4 transition-shadow duration-120 focus-within:shadow-md',
          expanded && 'rounded-b-none shadow-md',
        )}
      >
        <SearchIcon aria-hidden className="size-4.5 shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Поиск"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={expanded && current >= 0 ? optionId(current) : undefined}
          placeholder={PLACEHOLDER}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(-1)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden"
        />
        <Kbd aria-hidden>/</Kbd>
      </div>
      {expanded ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Подсказки"
          className="absolute inset-x-0 top-full z-50 max-h-[min(30rem,calc(100dvh-5rem))] overflow-y-auto rounded-b-xl border-border border-t bg-popover p-1.5 shadow-md"
        >
          {groups.map((group, groupIndex) => {
            const offset = groups
              .slice(0, groupIndex)
              .reduce((sum, previous) => sum + previous.items.length, 0)
            return (
              <div key={group.label ?? 'footer'} role="presentation">
                {group.label ? (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-ink-3 text-sm">
                    {group.label}
                  </div>
                ) : (
                  <div role="presentation" className="-mx-1.5 my-1.5 h-px bg-border" />
                )}
                {group.items.map((suggestion, itemIndex) => {
                  const position = offset + itemIndex
                  return (
                    <SuggestionRow
                      key={suggestion.key}
                      id={optionId(position)}
                      suggestion={suggestion}
                      active={position === current}
                      onHover={() => setActiveIndex(position)}
                      onActivate={() => activate(suggestion)}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
