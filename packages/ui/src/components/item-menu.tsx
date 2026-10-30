import { EllipsisIcon } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { Button, type ButtonProps } from './button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from './context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu'

/** Пункт меню «⋯» и правого клика (DESIGN §3.6): словами, со своим действием или подменю. */
export interface MenuAction {
  id: string
  label: string
  onSelect?: () => void
  icon?: ComponentType<{ className?: string }>
  /** Серая вторая строка: будущее имя файла, «соберётся по запросу». */
  hint?: string
  disabled?: boolean
  /** Подменю: «Скачать ▾», «В промо ▾». */
  items?: readonly MenuAction[]
}

/** Одна модель меню элемента. Опасные пункты идут внизу, отделённые линией. */
export interface ItemMenuModel {
  actions: readonly MenuAction[]
  dangerActions?: readonly MenuAction[]
}

interface ItemProps {
  onSelect?: () => void
  disabled?: boolean
  variant?: 'default' | 'destructive'
  className?: string
  children: ReactNode
}

interface MenuParts {
  Item: ComponentType<ItemProps>
  Separator: ComponentType
  Sub: ComponentType<{ children: ReactNode }>
  SubTrigger: ComponentType<{ disabled?: boolean; children: ReactNode }>
  SubContent: ComponentType<{ children: ReactNode }>
}

const dropdownParts: MenuParts = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
}

const contextParts: MenuParts = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
}

function ActionLabel({ action }: { action: MenuAction }) {
  const Icon = action.icon
  return (
    <>
      {Icon ? <Icon /> : null}
      {action.hint ? (
        <span className="flex min-w-0 flex-col">
          <span>{action.label}</span>
          <span className="truncate text-ink-3 text-sm">{action.hint}</span>
        </span>
      ) : (
        action.label
      )}
    </>
  )
}

function MenuEntries({
  actions,
  parts,
  danger = false,
}: {
  actions: readonly MenuAction[]
  parts: MenuParts
  danger?: boolean
}) {
  const { Item, Sub, SubTrigger, SubContent } = parts
  return actions.map((action) =>
    action.items ? (
      <Sub key={action.id}>
        <SubTrigger disabled={action.disabled}>
          <ActionLabel action={action} />
        </SubTrigger>
        <SubContent>
          <MenuEntries actions={action.items} parts={parts} />
        </SubContent>
      </Sub>
    ) : (
      <Item
        key={action.id}
        onSelect={action.onSelect}
        disabled={action.disabled}
        variant={danger ? 'destructive' : 'default'}
      >
        <ActionLabel action={action} />
      </Item>
    ),
  )
}

function MenuBody({ menu, parts }: { menu: ItemMenuModel; parts: MenuParts }) {
  const { Separator } = parts
  const dangerActions = menu.dangerActions ?? []
  return (
    <>
      <MenuEntries actions={menu.actions} parts={parts} />
      {dangerActions.length > 0 ? (
        <>
          <Separator />
          <MenuEntries actions={dangerActions} parts={parts} danger />
        </>
      ) : null}
    </>
  )
}

interface ItemMenuButtonProps {
  menu: ItemMenuModel
  /** Подпись кнопки для чтения с экрана. */
  label?: string
  variant?: ButtonProps['variant']
  size?: 'icon' | 'icon-sm'
  align?: 'start' | 'end'
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

/** Кнопка «⋯» с меню элемента. */
export function ItemMenuButton({
  menu,
  label = 'Ещё',
  variant = 'ghost',
  size = 'icon',
  align = 'end',
  open,
  onOpenChange,
  className,
}: ItemMenuButtonProps) {
  // Нечего предложить (например, «Только чтение») — кнопки нет, а не пустое меню.
  if (menu.actions.length === 0 && !menu.dangerActions?.length) return null
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} aria-label={label} className={className}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <MenuBody menu={menu} parts={dropdownParts} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** То же меню по правому клику на элементе (`children` — сам элемент). */
export function ItemContextMenu({ menu, children }: { menu: ItemMenuModel; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <MenuBody menu={menu} parts={contextParts} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Содержимое меню для своего `DropdownMenuContent` (например, в полосе выделения). */
export function ItemMenuItems({ menu }: { menu: ItemMenuModel }) {
  return <MenuBody menu={menu} parts={dropdownParts} />
}
