import {
  type CatalogEntry,
  FAN_NAME_LABEL,
  formatDate,
  formatDuration,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { Thumb } from '@contentops/ui/components/thumb'
import { UiLink } from '@contentops/ui/components/ui-link'
import { cn } from '@contentops/ui/lib/utils'
import type { MouseEvent } from 'react'
import { useToday } from '@/data/api-session'
import { itemCover } from '@/lib/item-cover'
import { deliveredOn, fanNameOf } from './to-ppv-rows'

interface ToPpvRowProps {
  entry: CatalogEntry
  selected: boolean
  /** Адрес сделанного PPV: «→ PPV-076». */
  ppvHref: string | null
  /** «Сделать PPV»; у «Только чтение» кнопки нет. */
  onMakePpv: (() => void) | null
}

/** Кнопка и ссылка в строке не выделяют саму строку. */
function stop(event: MouseEvent) {
  event.stopPropagation()
}

/**
 * Строка «Переделки в PPV» 52 (DESIGN §4.2): миниатюра, «CUS-181 Нейлон и каблуки»,
 * длительность, есть ли имя фана, дата сдачи; справа «Сделать PPV» или «→ PPV-076».
 */
export function ToPpvRow({ entry, selected, ppvHref, onMakePpv }: ToPpvRowProps) {
  const today = useToday()
  const cover = itemCover(entry)
  const nameMissing = fanNameOf(entry) === 'no'
  return (
    <div
      data-selected={selected}
      className={cn(
        'flex h-13 min-w-0 items-center gap-3 rounded-lg px-2 transition-colors duration-120 hover:bg-accent',
        selected && 'bg-primary-tint hover:bg-primary-tint',
      )}
    >
      <Thumb
        seed={cover.seed}
        kind={cover.kind}
        family={cover.family}
        src={cover.src}
        aspect="1:1"
        showCaptions={false}
        className="w-10 shrink-0 rounded-md"
      />
      <p className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-ink-3 text-sm tabular-nums">{entry.id}</span>
        <span className="truncate text-base">{entry.title}</span>
      </p>
      <span className="w-14 shrink-0 text-right text-muted-foreground text-sm tabular-nums">
        {entry.duration_s === null ? '' : formatDuration(entry.duration_s)}
      </span>
      <span
        className={cn(
          'w-28 shrink-0 text-sm',
          nameMissing ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {FAN_NAME_LABEL[fanNameOf(entry)]}
      </span>
      <span className="w-24 shrink-0 text-muted-foreground text-sm tabular-nums">
        сдано {formatDate(deliveredOn(entry), today)}
      </span>
      <span className="flex w-32 shrink-0 justify-end">
        {entry.ppv_made_as && ppvHref ? (
          <UiLink
            href={ppvHref}
            onClick={stop}
            className="rounded-sm text-primary-ink text-sm tabular-nums underline-offset-4 hover:underline"
          >
            → {entry.ppv_made_as}
          </UiLink>
        ) : null}
        {entry.ppv_made_as === null && onMakePpv ? (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => {
              stop(event)
              onMakePpv()
            }}
          >
            Сделать PPV
          </Button>
        ) : null}
      </span>
    </div>
  )
}
