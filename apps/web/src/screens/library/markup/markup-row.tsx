import type { CatalogEntry } from '@contentops/contracts'
import { Badge } from '@contentops/ui/components/badge'
import { Checkbox } from '@contentops/ui/components/checkbox'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { memo } from 'react'
import { itemCover } from '@/lib/item-cover'
import type { MarkupRowValues } from './markup-values'

interface MarkupRowProps {
  entry: CatalogEntry
  values: MarkupRowValues
  selected: boolean
  onToggle: (id: string, selected: boolean) => void
}

/** Высота строки «Приехало», сверки и заказа — у этой строки тоже две строки текста (§7.3). */
export const MARKUP_ROW_HEIGHT = 64

function Value({ text, className }: { text: string; className?: string }) {
  return text ? (
    <p className={cn('line-clamp-2 text-muted-foreground text-sm', className)}>{text}</p>
  ) : (
    <p className="text-ink-3 text-sm">не заполнено</p>
  )
}

/**
 * Строка «Разметки на проверку» (DESIGN §4.20): видны значения полей — название, теги,
 * описание; черновик ИИ серым с маленькой меткой «ИИ», без янтаря.
 */
export const MarkupRow = memo(function MarkupRow({
  entry,
  values,
  selected,
  onToggle,
}: MarkupRowProps) {
  return (
    <div
      data-entry-id={entry.id}
      data-selected={selected}
      className="group/tile grid h-full grid-cols-[1.25rem_2.5rem_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.5fr)] items-center gap-x-4 rounded-lg px-2 transition-colors duration-120 hover:bg-accent data-[selected=true]:bg-primary-tint"
    >
      <span className="flex size-5 items-center justify-center opacity-0 transition-opacity duration-120 group-hover/tile:opacity-100 group-data-[selected=true]/tile:opacity-100">
        <Checkbox
          checked={selected}
          aria-label={`Выбрать «${entry.title}»`}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onCheckedChange={(checked) => onToggle(entry.id, checked === true)}
        />
      </span>
      <Thumb {...itemCover(entry)} aspect="3:4" showCaptions={false} className="w-10 rounded-md" />
      <div className="flex min-w-0 flex-col">
        <p className={cn('truncate text-base', !values.title && 'text-ink-3')}>
          {values.title || 'не заполнено'}
        </p>
        <p className="flex items-center gap-2 text-ink-3 text-sm tabular-nums">
          {entry.id}
          {values.fromAi ? <Badge variant="outline">ИИ</Badge> : null}
        </p>
      </div>
      <Value text={values.tags} />
      <Value text={values.description} />
    </div>
  )
})
