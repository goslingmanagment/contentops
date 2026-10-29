import type { CatalogEntry } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { itemCover } from '@/lib/item-cover'
import { metaLine } from '@/objects/item-facts'

/** Откуда делается PPV: миниатюра 40 и строка «CUS-197 · Босс · Кастом · 15:37». */
export function SourceLine({ entry, extra }: { entry: CatalogEntry; extra?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-accent p-2">
      <Thumb {...itemCover(entry)} showCaptions={false} className="w-10 shrink-0 rounded-md" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          <span className="text-ink-3 tabular-nums">{entry.id}</span> · {entry.title}
        </span>
        <span className="truncate text-muted-foreground text-sm">{extra ?? metaLine(entry)}</span>
      </span>
    </div>
  )
}
