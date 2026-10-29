import {
  ActorTypeSchema,
  type ItemId,
  JournalAreaSchema,
  JournalResultSchema,
  parseIdQuery,
  type Role,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import {
  FilterChipButton,
  FilterChipsRow,
  FilterSelectChip,
} from '@contentops/ui/components/filter-chips'
import { Input } from '@contentops/ui/components/input'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { type FormEvent, useId, useState } from 'react'
import type { z } from 'zod'
import { useKeyboardShortcut } from '@/lib/use-keyboard-shortcut'
import {
  areaOptions,
  hasJournalFilters,
  PERIOD_OPTIONS,
  RESULT_OPTIONS,
  WHO_OPTIONS,
} from './journal-filter'
import { JournalPeriodSchema, type JournalSearch } from './search'

interface JournalChipsProps {
  search: JournalSearch
  role: Role | null
  onChange: (patch: Partial<JournalSearch>) => void
  onReset: () => void
}

/** Одно значение чипа из списка: пустой выбор снимает фильтр. */
function single<Schema extends z.ZodType>(schema: Schema, values: readonly string[]) {
  const parsed = schema.safeParse(values[0])
  return parsed.success ? parsed.data : undefined
}

function listOf(value: string | undefined): string[] {
  return value ? [value] : []
}

/**
 * Чипы журнала (DESIGN §4.18) как в «Истории» Я.Диска: «Кто», «Что», «Объект»,
 * «Результат», «Период» и «Сбросить». Ряд стоит всегда.
 */
export function JournalChips({ search, role, onChange, onReset }: JournalChipsProps) {
  return (
    <FilterChipsRow canReset={hasJournalFilters(search)} onReset={onReset} className="mb-2">
      <FilterSelectChip
        label="Кто"
        options={WHO_OPTIONS}
        selected={listOf(search.who)}
        onSelectedChange={(values) => onChange({ who: single(ActorTypeSchema, values) })}
      />
      <FilterSelectChip
        label="Что"
        options={areaOptions(role)}
        selected={listOf(search.what)}
        onSelectedChange={(values) => onChange({ what: single(JournalAreaSchema, values) })}
      />
      <ItemChip item={search.item} onChange={(item) => onChange({ item })} />
      <FilterSelectChip
        label="Результат"
        options={RESULT_OPTIONS}
        selected={listOf(search.result)}
        onSelectedChange={(values) => onChange({ result: single(JournalResultSchema, values) })}
      />
      <FilterSelectChip
        label="Период"
        options={PERIOD_OPTIONS}
        selected={listOf(search.period)}
        onSelectedChange={(values) => onChange({ period: single(JournalPeriodSchema, values) })}
      />
    </FilterChipsRow>
  )
}

interface ItemChipProps {
  item: ItemId | undefined
  onChange: (item: ItemId | undefined) => void
}

/**
 * «Объект»: номер в любом виде — «ппв 73», «PPV-073», «cus183». Клавиша `/` в Журнале
 * открывает этот фильтр, а не общий поиск (§4.18).
 */
function ItemChip({ item, onChange }: ItemChipProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const inputId = useId()

  const openWith = (next: boolean) => {
    setOpen(next)
    if (next) {
      setDraft(item ?? '')
      setInvalid(false)
    }
  }
  useKeyboardShortcut({ code: 'Slash', capture: true }, () => openWith(true))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim()) {
      onChange(undefined)
      setOpen(false)
      return
    }
    const id = parseIdQuery(draft)
    if (!id) {
      setInvalid(true)
      return
    }
    onChange(id)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={openWith}>
      <PopoverTrigger asChild>
        <FilterChipButton active={item !== undefined}>
          {item ? `Объект: ${item}` : 'Объект'}
        </FilterChipButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-ink-3 text-sm">
            Номер объекта
          </label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              autoFocus
              value={draft}
              aria-invalid={invalid}
              onChange={(event) => {
                setDraft(event.target.value)
                setInvalid(false)
              }}
              placeholder="ппв 73, SET-074"
            />
            <Button type="submit" variant="secondary">
              Показать
            </Button>
          </div>
          <p className="min-h-4.5 text-sm text-destructive">
            {invalid ? 'Не похоже на номер объекта' : null}
          </p>
        </form>
      </PopoverContent>
    </Popover>
  )
}
