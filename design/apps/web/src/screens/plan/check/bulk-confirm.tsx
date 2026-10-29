import {
  type Account,
  type CatalogEntry,
  type CheckCase,
  formatNumber,
  type ItemId,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { HeaderAction } from '@contentops/ui/components/field-header'
import { Popover, PopoverContent, PopoverTrigger } from '@contentops/ui/components/popover'
import { CheckCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { pairNumbers } from './case-text'

interface BulkConfirmProps {
  /** Однозначные пары Fansly из ответа сервера, ещё не решённые. */
  cases: readonly CheckCase[]
  accounts: readonly Account[]
  catalog: ReadonlyMap<ItemId, CatalogEntry> | undefined
  pending: boolean
  onConfirm: (cases: readonly CheckCase[]) => void
}

/**
 * «Подтвердить однозначные · 2» (DESIGN §4.15): всплывашка у кнопки со списком пар — ID,
 * страница, «+6 мин · 0:09 = 0:09» — с галочками и «Подтвердить 2». OnlyFans сюда не
 * попадает никогда: у таких пар `unambiguous` всегда ложно.
 */
export function BulkConfirm({ cases, accounts, catalog, pending, onConfirm }: BulkConfirmProps) {
  const [open, setOpen] = useState(false)
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set())
  const chosen = cases.filter((entry) => !unchecked.has(entry.id))
  const labelOf = (entry: CheckCase) =>
    accounts.find((account) => account.code === entry.account)?.label ?? entry.account

  const toggle = (id: string, checked: boolean) =>
    setUnchecked((current) => {
      const next = new Set(current)
      if (checked) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setUnchecked(new Set())
        }
      }}
    >
      <PopoverTrigger asChild>
        <HeaderAction
          icon={<CheckCheckIcon />}
          label={`Подтвердить однозначные · ${formatNumber(cases.length)}`}
          collapse="truncate"
          pending={pending}
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-90">
        <ul className="flex flex-col gap-1">
          {cases.map((entry) => {
            const id = `bulk-${entry.id}`
            return (
              <li key={entry.id} className="flex items-start gap-3 py-1.5">
                <Checkbox
                  id={id}
                  checked={!unchecked.has(entry.id)}
                  onCheckedChange={(checked) => toggle(entry.id, checked === true)}
                  className="mt-0.5"
                />
                <label htmlFor={id} className="flex min-w-0 flex-col">
                  <span className="truncate text-base tabular-nums">
                    {entry.version_label ?? entry.title}
                    <span className="text-ink-3"> · {labelOf(entry)}</span>
                  </span>
                  <span className="text-ink-3 text-sm tabular-nums">
                    {pairNumbers(entry, entry.item_id ? catalog?.get(entry.item_id) : undefined)}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <Button
          disabled={chosen.length === 0}
          onClick={() => {
            setOpen(false)
            onConfirm(chosen)
          }}
          className="self-start"
        >
          Подтвердить {formatNumber(chosen.length)}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
