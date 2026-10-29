import { ROLE_LABEL } from '@contentops/contracts'
import { Avatar, AvatarFallback } from '@contentops/ui/components/avatar'
import { Button } from '@contentops/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { useNavigate } from '@tanstack/react-router'
import { LogOutIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useSession } from '@/data/session'

/** Аватар справа (DESIGN §2.1): «Профиль и сессии», «Настройки», «Выйти». */
export function AccountMenu() {
  const person = useSession().data?.person
  const navigate = useNavigate()
  if (!person) {
    return <span aria-hidden className="size-9" />
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${person.name}: профиль и выход`}>
          <Avatar className="size-8">
            <AvatarFallback>{person.name.charAt(0)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="text-base text-foreground">{person.name}</span>
          <span>{ROLE_LABEL[person.role]}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void navigate({ to: '/settings/$tab', params: { tab: 'profile' } })}
        >
          <UserIcon />
          Профиль и сессии
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate({ to: '/settings' })}>
          <SettingsIcon />
          Настройки
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: '/login' })}>
          <LogOutIcon />
          Выйти
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
