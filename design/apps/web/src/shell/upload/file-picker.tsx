import { formatBytes, formatNumber } from '@contentops/contracts'
import { buttonVariants } from '@contentops/ui/components/button'
import { cn } from '@contentops/ui/lib/utils'
import { type DragEvent, useId, useState } from 'react'

const VISIBLE_FILES = 4

interface FilePickerProps {
  files: readonly File[]
  onFilesChange: (files: File[]) => void
  error?: string
  /** Один файл («Загрузить свой монтаж»): подписи в единственном числе, выбор без `multiple`. */
  single?: boolean
}

/** Выбор файлов: перетащить в рамку или «Выбрать файлы»; выбранное — списком с размером. */
export function FilePicker({ files, onFilesChange, error, single = false }: FilePickerProps) {
  const inputId = useId()
  const [dragOver, setDragOver] = useState(false)
  const addFiles = (list: FileList | null) => {
    if (list && list.length > 0) {
      onFilesChange([...files, ...Array.from(list)])
    }
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDragOver(false)
    addFiles(event.dataTransfer.files)
  }
  const hidden = files.length - VISIBLE_FILES

  return (
    <section className="flex flex-col gap-2">
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-input border-dashed px-4 py-5 text-center transition-colors duration-120 hover:bg-accent has-focus-visible:outline-2 has-focus-visible:outline-ring has-focus-visible:outline-offset-2',
          dragOver && 'border-primary bg-primary-tint',
        )}
      >
        <span className="text-base text-muted-foreground">
          {single ? 'Перетащите файл сюда' : 'Перетащите файлы сюда'}
        </span>
        <span className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          {single ? 'Выбрать файл' : 'Выбрать файлы'}
        </span>
        <input
          id={inputId}
          type="file"
          multiple={!single}
          className="sr-only"
          onChange={(event) => {
            addFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </label>
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {files.slice(0, VISIBLE_FILES).map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-baseline justify-between gap-3"
            >
              <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
              <span className="shrink-0 text-ink-3 text-sm tabular-nums">
                {formatBytes(file.size)}
              </span>
            </li>
          ))}
          {hidden > 0 ? <li className="text-ink-3 text-sm">и ещё {formatNumber(hidden)}</li> : null}
        </ul>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </section>
  )
}
