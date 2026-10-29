import { Thumb } from '@contentops/ui/components/thumb'
import { InboxIcon } from 'lucide-react'
import { itemCoverById } from '@/lib/item-cover'
import type { UploadTarget } from './upload-target'

/** «Куда»: объект или строка плана с миниатюрой; у «Другое» — группа в «Приехало». */
export function TargetLine({
  target,
  kindIsOther,
}: {
  target: UploadTarget | null
  kindIsOther: boolean
}) {
  if (kindIsOther) {
    return (
      <p className="flex items-center gap-3 text-base">
        <span className="flex h-10 w-7.5 shrink-0 items-center justify-center rounded-md bg-muted">
          <InboxIcon className="size-4 text-ink-3" />
        </span>
        В Приехало, группой «Загружено вами»
      </p>
    )
  }
  if (!target) {
    return <p className="text-base text-muted-foreground">Цель не выбрана</p>
  }
  return (
    <p className="flex min-w-0 items-center gap-3 text-base">
      {target.kind === 'item' ? (
        <Thumb
          {...itemCoverById(target.itemId)}
          showCaptions={false}
          className="w-7.5 shrink-0 rounded-md"
        />
      ) : null}
      <span className="min-w-0 truncate">
        {target.kind === 'item' ? (
          <span className="text-ink-3 tabular-nums">{target.itemId} · </span>
        ) : null}
        {target.title}
      </span>
    </p>
  )
}
