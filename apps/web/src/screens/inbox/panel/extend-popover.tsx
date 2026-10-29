import {
  type CatalogEntry,
  EXTEND_ROLE_LABEL,
  type ExtendRole,
  ExtendRoleSchema,
  type InboxGroup,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { RadioGroup, RadioGroupItem } from '@contentops/ui/components/radio-group'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { type FormEvent, type ReactNode, useId, useMemo, useState } from 'react'
import { useCatalogIndex } from '@/data/catalog'
import { useCatalogSearch } from '@/data/catalog-search'
import { itemCover } from '@/lib/item-cover'
import { useCurrentModel } from '@/shell/model/model-context'

const RESULTS = 6
const ROLES = ExtendRoleSchema.options

interface ExtendPopoverProps {
  group: InboxGroup
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Куда деть фокус после закрытия; по умолчанию — на кнопку, которая открыла. */
  onCloseAutoFocus?: (event: Event) => void
  onExtend: (itemId: ItemId, role: ExtendRole) => void
  children: ReactNode
}

/**
 * «Дополнить…» (DESIGN §2.5): найти объект и выбрать, кем станут файлы — фото, тизером
 * или новой версией мастера. Роль не подставляется: решает человек.
 */
export function ExtendPopover({
  group,
  open,
  onOpenChange,
  onCloseAutoFocus,
  onExtend,
  children,
}: ExtendPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-90 gap-3" onCloseAutoFocus={onCloseAutoFocus}>
        {open ? (
          <ExtendForm
            group={group}
            onExtend={(itemId, role) => {
              onOpenChange(false)
              onExtend(itemId, role)
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function ExtendForm({
  group,
  onExtend,
}: {
  group: InboxGroup
  onExtend: (itemId: ItemId, role: ExtendRole) => void
}) {
  const model = useCurrentModel().code
  const index = useCatalogIndex(model).data
  const search = useCatalogSearch(model)
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<ItemId | null>(group.target_item ?? null)
  const [role, setRole] = useState<ExtendRole | null>(null)
  const inputId = useId()

  const results = useMemo(() => {
    if (query.trim() && search) {
      // «SET-07» ищется как «set 07», так же, как ID лежит в индексе.
      return search.find(query.replaceAll('-', ' '), RESULTS)
    }
    const sameType = (index?.items ?? [])
      .filter((entry) => entry.type === group.fields.type || entry.id === group.target_item)
      .toSorted((left, right) => right.arrived_on.localeCompare(left.arrived_on))
    return sameType.slice(0, RESULTS)
  }, [group.fields.type, group.target_item, index, query, search])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (target && role) {
      onExtend(target, role)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor={inputId} className="font-semibold text-lg">
        Дополнить объект
      </label>
      <Input
        id={inputId}
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ID или название: SET-074, чтение книги"
      />
      <ul aria-label="Объекты" className="-mx-1 flex max-h-64 flex-col overflow-y-auto">
        {results.map((entry) => (
          <li key={entry.id}>
            <ResultRow entry={entry} chosen={entry.id === target} onChoose={setTarget} />
          </li>
        ))}
        {results.length === 0 ? (
          <li className="px-2 py-3 text-muted-foreground text-sm">Ничего не нашлось</li>
        ) : null}
      </ul>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-ink-3 text-sm">Файлы станут</legend>
        <RadioGroup
          value={role ?? ''}
          onValueChange={(value) => setRole(ExtendRoleSchema.safeParse(value).data ?? null)}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {ROLES.map((option) => (
            <span key={option} className="inline-flex items-center gap-2 text-base">
              <RadioGroupItem id={`${inputId}-${option}`} value={option} />
              <label htmlFor={`${inputId}-${option}`}>{EXTEND_ROLE_LABEL[option]}</label>
            </span>
          ))}
        </RadioGroup>
      </fieldset>
      <Button type="submit" disabled={!target || !role} className="self-start">
        {target ? `Дополнить ${target}` : 'Дополнить'}
      </Button>
    </form>
  )
}

function ResultRow({
  entry,
  chosen,
  onChoose,
}: {
  entry: CatalogEntry
  chosen: boolean
  onChoose: (id: ItemId) => void
}) {
  const cover = itemCover(entry)
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={() => onChoose(entry.id)}
      className={cn(
        'flex h-13 w-full min-w-0 items-center gap-3 rounded-lg px-1 text-left transition-colors duration-120 hover:bg-accent',
        chosen && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <Thumb
        seed={cover.seed}
        kind={cover.kind}
        family={cover.family}
        showCaptions={false}
        className="w-7.5 shrink-0 rounded-md"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{entry.title}</span>
        <span className="text-ink-3 text-sm tabular-nums">{entry.id}</span>
      </span>
    </button>
  )
}
