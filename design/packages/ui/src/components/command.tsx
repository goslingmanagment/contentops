import { Command as CommandPrimitive } from 'cmdk'
import { cn } from 'cn'
import { CheckIcon, SearchIcon } from 'lucide-react'
import type * as React from 'react'
import { menuItemClass, menuLabelClass, menuSeparatorClass } from '../lib/menu-styles'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'

/** Список с поиском: выбор значений чипа, выпадающий поиск (DESIGN §8). */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex size-full flex-col overflow-hidden bg-popover text-base text-popover-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title,
  description,
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title: string
  description?: string
  className?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn('top-1/3 translate-y-0 gap-0 overflow-hidden p-0', className)}
        showCloseButton={showCloseButton}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-11 items-center gap-2.5 border-border border-b px-3.5"
    >
      <SearchIcon className="size-4 shrink-0 text-ink-3" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'h-full w-full bg-transparent text-base outline-hidden placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'max-h-80 scroll-py-1.5 overflow-x-hidden overflow-y-auto p-1.5 outline-none',
        className,
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn('px-3 py-6 text-center text-muted-foreground', className)}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'overflow-hidden text-foreground **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-ink-3 **:[[cmdk-group-heading]]:text-sm',
        className,
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  )
}

/**
 * Пункт списка. `checked` рисует синюю галочку справа — так выбор значений чипа
 * виден без отдельных флажков.
 */
function CommandItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & { checked?: boolean }) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      data-checked={checked}
      aria-checked={checked}
      className={cn(
        menuItemClass,
        'data-[selected=true]:bg-accent data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      {checked === undefined ? null : (
        <CheckIcon
          aria-hidden
          className={cn('ml-auto text-primary', checked ? 'opacity-100' : 'opacity-0')}
        />
      )}
    </CommandPrimitive.Item>
  )
}

function CommandLabel({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="command-label" className={cn(menuLabelClass, className)} {...props} />
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto text-ink-3 text-sm', className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandLabel,
  CommandList,
  CommandSeparator,
  CommandShortcut,
}
