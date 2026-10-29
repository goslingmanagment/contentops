import type { Dispute, DisputeFolder } from '@contentops/contracts'
import { Thumb } from '@contentops/ui/components/thumb'
import { ToggleGroup, ToggleGroupItem } from '@contentops/ui/components/toggle-group'
import { UNCLEAR_OPTION } from './use-legacy-actions'

/** Выбор у каждой папки «Номер занят»: имя папки → вариант. */
export type FolderChoice = Readonly<Record<string, string>>

/** Короткие слова вариантов у папки (§4.9): «оставить / новый номер / опечатка / неясно». */
const SHORT: Readonly<Record<string, string>> = { [UNCLEAR_OPTION]: 'неясно' }

/** Выбор по предложению нормы: первая папка оставляет номер, остальные получают новые. */
export function proposedChoice(folders: readonly DisputeFolder[]): FolderChoice {
  return Object.fromEntries(folders.map((folder) => [folder.name, folder.proposal]))
}

export function sameChoice(left: FolderChoice, right: FolderChoice): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

interface FolderChoicesProps {
  dispute: Dispute
  value: FolderChoice
  disabled: boolean
  onChange: (folder: string, option: string) => void
}

/**
 * Папки «Номер занят» строками (DESIGN §4.9): обложка, имя моноширинным и выбор у каждой.
 * Сначала выбрано то, что предлагает норма, — видно, какая папка получит новый номер.
 */
export function FolderChoices({ dispute, value, disabled, onChange }: FolderChoicesProps) {
  return (
    <ul className="flex flex-col gap-1">
      {dispute.folders.map((folder) => (
        <li
          key={folder.name}
          className="grid min-h-11 grid-cols-[1.875rem_minmax(8rem,1fr)_auto] items-center gap-3"
        >
          <Thumb seed={folder.thumb.key} showCaptions={false} className="w-7.5 rounded-md" />
          <span className="truncate font-mono text-sm" title={folder.name}>
            {folder.name}
          </span>
          <ToggleGroup
            type="single"
            variant="segment"
            aria-label={`Что сделать с ${folder.name}`}
            value={value[folder.name] ?? ''}
            disabled={disabled}
            onValueChange={(option) => {
              if (option) {
                onChange(folder.name, option)
              }
            }}
            // Стрелки внутри выбора не должны уводить фокус по строкам спорного.
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {dispute.options.map((option) => (
              <ToggleGroupItem key={option.key} value={option.key} className="px-2 text-sm">
                {SHORT[option.key] ?? option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </li>
      ))}
    </ul>
  )
}
