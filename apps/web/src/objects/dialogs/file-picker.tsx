import type { CatalogEntry, ItemId, MediaKind, ModelCode } from '@contentops/contracts'
import { Input } from '@contentops/ui/components/input'
import { Thumb } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { useId, useState } from 'react'
import { useItem } from '@/data/object'
import { fileCover } from '@/screens/object/files/file-thumb'
import { ItemPicker } from './item-picker'

interface FilePickerProps {
  model: ModelCode
  /** Объекты, из которых выбирать. */
  entries: readonly CatalogEntry[]
  /** Только файлы этого вида: копия фото — фото, мастер — видео. */
  media: MediaKind
  /** Файл, который выбирать нельзя: сама копия. */
  except?: string
  /** `LIFE-005/pic34`; пустая строка — не выбран. */
  value: string
  onChange: (address: string) => void
}

/**
 * Файл каталога в окне: объект поиском, затем его файл плиткой; адрес можно и написать —
 * так выбирается файл удалённого или слитого объекта (`FYP-0036/master`), которого нет в
 * Библиотеке.
 */
export function FilePicker({ model, entries, media, except, value, onChange }: FilePickerProps) {
  const [item, setItem] = useState<ItemId | null>(null)
  const detail = useItem(model, item ?? ('PPV-000' as ItemId), { enabled: item !== null })
  const addressId = useId()
  const files = (item ? (detail.data?.files ?? []) : []).filter(
    (file) => file.media === media && `${item}/${file.key}` !== except,
  )
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <ItemPicker label="Найти объект" entries={entries} value={item} onChange={setItem} />
      {item ? (
        <div role="listbox" aria-label={`Файлы ${item}`} className="flex flex-wrap gap-2">
          {files.length === 0 ? (
            <p className="text-ink-3 text-sm">
              {detail.isPending ? 'Файлы загружаются…' : 'Подходящих файлов нет'}
            </p>
          ) : null}
          {files.map((file) => {
            const address = `${item}/${file.key}`
            const cover = detail.data ? fileCover(detail.data.entry, file) : null
            return (
              <button
                key={file.key}
                type="button"
                role="option"
                aria-selected={value === address}
                onClick={() => onChange(address)}
                className={cn(
                  'flex w-16 flex-col items-center gap-1 rounded-lg p-1 transition-colors duration-120 hover:bg-accent',
                  value === address && 'bg-primary-tint ring-2 ring-primary',
                )}
              >
                {cover ? (
                  <Thumb
                    seed={cover.seed}
                    kind={cover.kind}
                    family={cover.family}
                    src={cover.src}
                    showCaptions={false}
                    className="w-14 rounded-md"
                  />
                ) : null}
                <span className="text-ink-2 text-xs tabular-nums">{file.key}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={addressId} className="text-ink-3 text-sm">
          Адрес файла
        </label>
        <Input
          id={addressId}
          placeholder="LIFE-005/pic34"
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
        />
      </div>
    </div>
  )
}
