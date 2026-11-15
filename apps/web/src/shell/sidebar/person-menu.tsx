import { ROLE_LABEL } from '@contentops/contracts'
import { Avatar, AvatarFallback } from '@contentops/ui/components/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentops/ui/components/dropdown-menu'
import { cn } from '@contentops/ui/lib/utils'
import { useNavigate } from '@tanstack/react-router'
import { LogOutIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useSession } from '@/data/session'
import { useSignOut } from '@/screens/login/use-sign-in'

/**
 * Человек внизу колонки (план продуктов §2.1): имя и роль; по нажатию «Профиль и сессии»,
 * «Настройки», «Выйти». Отсюда в Настройки ведёт рамка.
 */
export function PersonMenu({ collapsed }: { collapsed: boolean }) {
  const person = useSession().data?.person
  const navigate = useNavigate()
  const signOut = useSignOut()
  if (!person) {
    return <span aria-hidden className="block h-12" />
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-12 w-full items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
          collapsed && 'justify-center px-0',
        )}
        aria-label={`${person.name}: профиль, настройки и выход`}
      >
        <Avatar className="size-8 shrink-0">
          <AvatarFallback>{person.name.charAt(0)}</AvatarFallback>
        </Avatar>
        {collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{person.name}</span>
            <span className="block truncate text-muted-foreground text-xs">
              {ROLE_LABEL[person.role]}
            </span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
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
        {person.role === 'customs' ? null : (
          <DropdownMenuItem onSelect={() => void navigate({ to: '/settings' })}>
            <SettingsIcon />
            Настройки
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut}>
          <LogOutIcon />
          Выйти
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
