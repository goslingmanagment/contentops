import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react'
import { Button } from './button'
import { Popover, PopoverAnchor, PopoverContent } from './popover'

export interface TagOption {
  /** Ключ тега в словаре. */
  value: string
  /** Русское имя, если оно есть в словаре; иначе ключ. */
  label: string
  /** Группа словаря: `action`, `attribute`, `mood`; у свободного тега её нет. */
  group?: string
}

export interface TagGroupOption {
  value: string
  /** «действия», «атрибуты», «настроение». */
  label: string
}

interface TagInputProps {
  value: readonly string[]
  onChange: (next: string[]) => void
  options: readonly TagOption[]
  /** Группы для «по группам»; без них ссылки нет. */
  groups?: readonly TagGroupOption[]
  /** Подпись поля для чтения с экрана: «Теги». */
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

const SUGGESTION_LIMIT = 8

function matchesOf(query: string, options: readonly TagOption[], chosen: ReadonlySet<string>) {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  return options
    .filter((option) => !chosen.has(option.value))
    .filter(
      (option) =>
        option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle),
    )
    .sort((left, right) => {
      const leftStarts = left.label.toLowerCase().startsWith(needle) ? 0 : 1
      const rightStarts = right.label.toLowerCase().startsWith(needle) ? 0 : 1
      return leftStarts - rightStarts || left.label.localeCompare(right.label, 'ru')
    })
    .slice(0, SUGGESTION_LIMIT)
}

/**
 * Теги трёх групп одной строкой (DESIGN §4.4): ввод с подсказками из словаря, `Enter`
 * добавляет, `Backspace` в пустом поле убирает последний. «по группам» раскрывает
 * действия, атрибуты и настроение списками. Новое слово становится свободным тегом.
 */
export function TagInput({
  value,
  onChange,
  options,
  groups,
  label,
  placeholder = 'Добавить тег',
  disabled = false,
  className,
}: TagInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const [showGroups, setShowGroups] = useState(false)

  const chosen = useMemo(() => new Set(value), [value])
  const byValue = useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const matches = useMemo(() => matchesOf(query, options, chosen), [query, options, chosen])
  const typed = query.trim()
  const exact = matches.some((option) => option.label.toLowerCase() === typed.toLowerCase())
  const suggestions: TagOption[] =
    typed && !exact && !chosen.has(typed) ? [...matches, { value: typed, label: typed }] : matches
  const open = focused && suggestions.length > 0
  const current = Math.min(active, suggestions.length - 1)

  const add = (tag: string) => {
    if (!chosen.has(tag)) {
      onChange([...value, tag])
    }
    setQuery('')
    setActive(0)
  }
  const remove = (tag: string) => onChange(value.filter((item) => item !== tag))
  const toggle = (tag: string) => (chosen.has(tag) ? remove(tag) : add(tag))

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number | undefined> = { ArrowDown: 1, ArrowUp: -1 }
    const step = moves[event.key]
    if (step !== undefined && suggestions.length > 0) {
      event.preventDefault()
      setActive((current + step + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Enter' && typed) {
      event.preventDefault()
      add(suggestions[current]?.value ?? typed)
      return
    }
    if (event.key === 'Escape' && query) {
      event.preventDefault()
      setQuery('')
      return
    }
    const last = value.at(-1)
    if (event.key === 'Backspace' && !query && last !== undefined) {
      remove(last)
    }
  }

  return (
    <div data-slot="tag-input" className={cn('flex flex-col gap-2', className)}>
      <Popover open={open}>
        <PopoverAnchor asChild>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: щелчок по свободному месту только ставит фокус в поле, клавиши слушает само поле */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: обёртка поля с метками, как у обычного поля ввода */}
          <div
            onClick={() => inputRef.current?.focus()}
            className={cn(
              'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1 transition-colors duration-120 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring',
              disabled && 'pointer-events-none opacity-50',
            )}
          >
            {value.map((tag) => {
              const tagLabel = byValue.get(tag)?.label ?? tag
              return (
                <span
                  key={tag}
                  className="inline-flex h-6 items-center gap-0.5 rounded-3xl bg-secondary pr-0.5 pl-2 text-sm"
                >
                  {tagLabel}
                  <button
                    type="button"
                    aria-label={`Убрать тег «${tagLabel}»`}
                    onClick={(event) => {
                      event.stopPropagation()
                      remove(tag)
                    }}
                    className="flex size-5 items-center justify-center rounded-full text-ink-3 transition-colors duration-120 hover:bg-secondary-hover hover:text-foreground"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </span>
              )
            })}
            <input
              ref={inputRef}
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open ? `${listId}-${current}` : undefined}
              value={query}
              disabled={disabled}
              placeholder={value.length === 0 ? placeholder : undefined}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              className="h-7 min-w-24 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-ink-3"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-(--radix-popover-trigger-width) gap-0 p-1"
        >
          <div id={listId} role="listbox" aria-label="Подсказки тегов">
            {suggestions.map((option, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши обрабатывает поле ввода (aria-activedescendant)
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(option.value)}
                onMouseEnter={() => setActive(index)}
                className="flex h-9 cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 text-base aria-selected:bg-accent"
              >
                <span className="truncate">
                  {byValue.has(option.value) ? option.label : `Добавить «${option.label}»`}
                </span>
                {option.group ? (
                  <span className="shrink-0 text-ink-3 text-sm">
                    {groups?.find((group) => group.value === option.group)?.label}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      {groups && groups.length > 0 ? (
        <>
          <Button
            variant="link"
            size="inline"
            aria-expanded={showGroups}
            onClick={() => setShowGroups((shown) => !shown)}
            className="self-start text-sm"
          >
            по группам
          </Button>
          {showGroups ? (
            <TagGroups groups={groups} options={options} chosen={chosen} onToggle={toggle} />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function TagGroups({
  groups,
  options,
  chosen,
  onToggle,
}: {
  groups: readonly TagGroupOption[]
  options: readonly TagOption[]
  chosen: ReadonlySet<string>
  onToggle: (tag: string) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.value} className="flex flex-col gap-1.5">
          <span className="text-ink-3 text-xs">{group.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {options
              .filter((option) => option.group === group.value)
              .map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={chosen.has(option.value)}
                  onClick={() => onToggle(option.value)}
                  className="h-7 rounded-3xl bg-secondary px-2.5 text-sm transition-colors duration-120 hover:bg-secondary-hover aria-pressed:bg-primary-tint aria-pressed:text-primary-ink"
                >
                  {option.label}
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
