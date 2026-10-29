import type { CheckCase, ItemId } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { CheckIcon, XIcon } from 'lucide-react'
import { itemCoverById } from '@/lib/item-cover'

/** Подпись под вложением: номер фото («фото 17» → «17»), у мастера — слово. */
function captionOf(label: string): string {
  return /\d+$/.exec(label)?.[0] ?? label
}

/** ✓ или ✗ в углу вложения: белый кружок у того, что дошло, красный — у пропавшего. */
function AttachmentSign({ ok }: { ok: boolean }) {
  const Sign = ok ? CheckIcon : XIcon
  return (
    <span
      className={cn(
        'absolute right-0.5 bottom-0.5 flex size-3.5 items-center justify-center rounded-full',
        ok ? 'bg-background text-foreground' : 'bg-destructive text-primary-foreground',
      )}
    >
      <Sign aria-label={ok ? 'есть' : 'нет'} strokeWidth={3} className="size-2.5" />
    </span>
  )
}

interface AttachmentGridProps {
  itemId: ItemId
  attachments: CheckCase['attachments']
}

/**
 * «Совпало 22 из 23» (DESIGN §4.15): вложения по 40 px с ✓ / ✗ в углу и номерами; чего
 * нет — в красной рамке и сверху словами: «Нет фото 17».
 */
export function AttachmentGrid({ itemId, attachments }: AttachmentGridProps) {
  const missing = attachments.filter((attachment) => !attachment.ok)
  const cover = itemCoverById(itemId)
  return (
    <div className="flex flex-col gap-2">
      {missing.length > 0 ? (
        <p className="text-base text-destructive">
          Нет {missing.map((attachment) => attachment.label).join(', ')}
        </p>
      ) : null}
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-x-2 gap-y-1.5">
        {attachments.map((attachment) => (
          <li
            key={attachment.no}
            title={attachment.ok ? attachment.label : `Нет ${attachment.label}`}
            className="flex flex-col items-center gap-0.5"
          >
            <Thumb
              seed={`${cover.seed}-${attachment.no}`}
              kind={cover.kind}
              family={cover.family}
              aspect="1:1"
              showCaptions={false}
              overlay={<AttachmentSign ok={attachment.ok} />}
              className={cn(
                'size-10 rounded-md',
                !attachment.ok && 'outline-2 outline-destructive -outline-offset-2',
              )}
            />
            <span
              className={cn(
                'max-w-full truncate text-xs tabular-nums',
                attachment.ok ? 'text-ink-3' : 'text-destructive',
              )}
            >
              {captionOf(attachment.label)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
