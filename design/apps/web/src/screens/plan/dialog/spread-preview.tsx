import {
  type Account,
  type CatalogEntry,
  formatNumber,
  UNIQ_LEVEL_LABEL,
  type UniqLevel,
} from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { useId } from 'react'
import { itemCover } from '@/lib/item-cover'
import { accountLabel } from '@/lib/words'
import { slotText } from '../shared/plan-text'
import type { RowNote } from './check-line'
import type { SpreadRow } from './spread'

/** Левая колонка окна для нескольких объектов: список выбранных с миниатюрами. */
export function SelectedList({ entries }: { entries: readonly CatalogEntry[] }) {
  return (
    <>
      <h3 className="text-ink-3 text-sm">Выбрано {formatNumber(entries.length)}</h3>
      <ul className="-mx-2 flex flex-col">
        {entries.map((entry) => (
          <li key={entry.id} className="flex h-12 items-center gap-3 px-2">
            <Thumb
              {...itemCover(entry)}
              showCaptions={false}
              className="w-7.5 shrink-0 rounded-md"
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-base">{entry.title}</span>
              <span className="text-ink-3 text-sm">{entry.id}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

interface SpreadPreviewProps {
  rows: readonly SpreadRow[]
  entries: readonly CatalogEntry[]
  accounts: readonly Account[]
  /** Уровень версий — только у фупов. */
  level: UniqLevel | null
  isChecked: (row: SpreadRow) => boolean
  onCheckedChange: (row: SpreadRow, checked: boolean) => void
  noteOf: (row: SpreadRow) => RowNote | null
  rejectedOf: (row: SpreadRow) => string | undefined
}

/** Предпросмотр строк (DESIGN §4.13): у каждой галочка и своя пометка проверки. */
export function SpreadPreview({
  rows,
  entries,
  accounts,
  level,
  isChecked,
  onCheckedChange,
  noteOf,
  rejectedOf,
}: SpreadPreviewProps) {
  return (
    <ul className="-mx-2 flex flex-col">
      {rows.map((row) => (
        <SpreadLine
          key={row.key}
          row={row}
          title={entries.find((entry) => entry.id === row.item)?.title ?? row.item}
          accountName={accountLabel(accounts, row.account)}
          level={level}
          checked={isChecked(row)}
          onCheckedChange={(checked) => onCheckedChange(row, checked)}
          note={noteOf(row)}
          rejected={rejectedOf(row)}
        />
      ))}
    </ul>
  )
}

interface SpreadLineProps {
  row: SpreadRow
  title: string
  accountName: string
  level: UniqLevel | null
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  note: RowNote | null
  rejected: string | undefined
}

/** «FYP-0801 → Fansly 2 · ср 23, 03:00 · версия 1 · мягко» и пометка проверки строки. */
function SpreadLine({
  row,
  title,
  accountName,
  level,
  checked,
  onCheckedChange,
  note,
  rejected,
}: SpreadLineProps) {
  const id = useId()
  const version = row.version
    ? ` · версия ${row.version.no}${level ? ` · ${UNIQ_LEVEL_LABEL[level]}` : ''}`
    : ''
  const text = rejected ?? (row.date === null ? 'мест нормы на неделе больше нет' : note?.text)
  const blocked = rejected !== undefined || note?.tone === 'blocked'
  return (
    <li className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-1 hover:bg-accent">
      <Checkbox
        id={id}
        checked={checked}
        disabled={row.date === null}
        onCheckedChange={(on) => onCheckedChange(on === true)}
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base">
          {row.item} → {accountName}
          {row.date ? ` · ${slotText(row.date, row.time)}` : ''}
          <span className="text-muted-foreground">{version}</span>
        </span>
        <span className="truncate text-ink-3 text-sm">
          {title}
          {text ? (
            <span className={cn(blocked ? 'text-destructive' : 'text-attention-ink')}>
              {' '}
              · {text}
            </span>
          ) : null}
        </span>
      </label>
    </li>
  )
}
