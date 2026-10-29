import {
  type DraftFile,
  FILE_ROLE_LABEL,
  type FileRole,
  FileRoleSchema,
} from '@contentops/contracts'
import { Checkbox } from '@contentops/ui/components/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import type { CoverKind } from '@contentops/ui/components/thumb'
import { cn } from '@contentops/ui/lib/utils'
import { ChevronDownIcon } from 'lucide-react'
import { FileThumb } from './file-thumb'

/** Роли, которые можно дать файлу черновика: ссылка промо появляется только в подборке. */
const ROLES = FileRoleSchema.options.filter((role) => role !== 'promo_link')

interface FileTileProps {
  file: DraftFile
  kind: CoverKind | undefined
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onRoleChange: (role: FileRole) => void
  disabled?: boolean
}

/**
 * Файл в панели группы (DESIGN §4.8): плитка 72 × 96, чип роли из имени («мастер»,
 * «тизер», «фото 3») с меню смены роли, галочка — для «Выделить в новую».
 */
export function FileTile({
  file,
  kind,
  checked,
  onCheckedChange,
  onRoleChange,
  disabled = false,
}: FileTileProps) {
  return (
    <div data-checked={checked} className="group/file relative w-18">
      <FileThumb
        file={file}
        kind={kind}
        className={cn(checked && 'outline-2 outline-primary outline-offset-1')}
        overlay={
          <span
            className={cn(
              'absolute right-1 bottom-1 flex size-5 items-center justify-center rounded-sm bg-background/90 opacity-0 transition-opacity duration-120 group-hover/file:opacity-100 has-focus-visible:opacity-100',
              checked && 'opacity-100',
            )}
          >
            <Checkbox
              checked={checked}
              aria-label={`Выбрать ${file.file_name}`}
              onCheckedChange={(value) => onCheckedChange(value === true)}
              onPointerDown={(event) => event.stopPropagation()}
              className="size-4"
            />
          </span>
        }
      />
      <RoleChip file={file} onRoleChange={onRoleChange} disabled={disabled} />
    </div>
  )
}

function RoleChip({
  file,
  onRoleChange,
  disabled,
}: {
  file: DraftFile
  onRoleChange: (role: FileRole) => void
  disabled: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={`Роль: ${file.role_label}. Сменить`}
        className="absolute top-1 left-1 inline-flex h-5 max-w-[calc(100%-0.5rem)] items-center gap-px rounded-sm bg-scrim px-1 text-2xs text-scrim-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate">{file.role_label}</span>
        <ChevronDownIcon
          aria-hidden
          className="hidden size-2.5 shrink-0 group-hover/file:block group-focus-within/file:block"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Роль файла</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={file.role}
          onValueChange={(value) => {
            const role = FileRoleSchema.safeParse(value).data
            if (role && role !== file.role) {
              onRoleChange(role)
            }
          }}
        >
          {ROLES.map((role) => (
            <DropdownMenuRadioItem key={role} value={role}>
              {FILE_ROLE_LABEL[role]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
