import type { RevisionBasis } from '@contentops/contracts'
import { Button, type ButtonProps } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'

/** Основание «Выполнена» (DESIGN §4.16, п. 5): проверила КМ или пришла новая версия. */
const BASES: readonly { basis: RevisionBasis; label: string }[] = [
  { basis: 'checked', label: 'проверено КМ' },
  { basis: 'new_version', label: 'новая версия' },
]

interface CompleteRevisionMenuProps {
  onComplete: (basis: RevisionBasis) => void
  pending: boolean
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
}

/** «Выполнена ▾»: основание выбирается одним нажатием, без окна. */
export function CompleteRevisionMenu({
  onComplete,
  pending,
  variant = 'outline',
  size = 'sm',
}: CompleteRevisionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} pending={pending}>
          <CheckIcon />
          Выполнена
          <ChevronDownIcon className="-mr-1 size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Основание</DropdownMenuLabel>
        {BASES.map((item) => (
          <DropdownMenuItem key={item.basis} onSelect={() => onComplete(item.basis)}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
