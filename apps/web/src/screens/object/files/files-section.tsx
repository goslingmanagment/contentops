import { formatNumber } from '@contentops/contracts'
import { cn } from '@contentops/ui/lib/utils'
import { type ReactNode, useId } from 'react'

interface FilesSectionProps {
  /** «Мастер и тизер», «Кадры мастера», «Фото». */
  title: string
  count?: number
  /** Серое уточнение после числа: «в порядке для заливки». */
  note?: string
  /** Действие справа: «Собрать версии», переключатель «Все кадры / Отобранные». */
  action?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Раздел файлов объекта (DESIGN §4.4): подпись 13/18 серым с числом и действием справа.
 * Разделы идут на первом экране сразу под строкой «где залито».
 */
export function FilesSection({
  title,
  count,
  note,
  action,
  children,
  className,
}: FilesSectionProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-2', className)}>
      <header className="flex min-h-7 items-center justify-between gap-3">
        <h2 id={titleId} className="text-ink-3 text-sm">
          <span className="font-medium text-muted-foreground">{title}</span>
          {count === undefined ? null : (
            <span className="ml-1.5 tabular-nums">{formatNumber(count)}</span>
          )}
          {note ? <span className="ml-1.5">{note}</span> : null}
        </h2>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** Пунктирное место файла, которого нет: «Тизера нет · перетащите сюда» (§4.5). */
export function MissingFile({
  children,
  width,
  aspect,
  onDropFiles,
}: {
  children: ReactNode
  width: number
  aspect: '9:16' | '3:4' | 'row'
  onDropFiles?: (files: File[]) => void
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: место принимает перетаскиваемые файлы; с клавиатуры — «Загрузить» в колонке
    <div
      onDragOver={(event) => {
        if (onDropFiles) {
          event.preventDefault()
        }
      }}
      onDrop={(event) => {
        if (!onDropFiles) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        onDropFiles([...event.dataTransfer.files])
      }}
      className={cn(
        'flex items-center justify-center rounded-lg border border-input border-dashed px-3 text-center text-muted-foreground text-sm',
        aspect === 'row' ? 'min-h-16' : 'm-1',
      )}
      style={
        aspect === 'row'
          ? undefined
          : { width, aspectRatio: aspect === '9:16' ? '9 / 16' : '3 / 4' }
      }
    >
      {children}
    </div>
  )
}
