import { cn } from 'cn'
import { Popover as PopoverPrimitive } from 'radix-ui'
import type * as React from 'react'
import { useSurfaceClass } from './dark-surface'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** Всплывашка (DESIGN §7.4–7.5, §7.8): радиус 12, тень всплывающего, появление 120 мс. */
function PopoverContent({
  className,
  align = 'center',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const surfaceClass = useSurfaceClass()
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          surfaceClass,
          'z-50 flex w-80 origin-(--radix-popover-content-transform-origin) flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-base text-popover-foreground shadow-md outline-hidden duration-120 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-98 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-98',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="popover-header" className={cn('flex flex-col gap-1', className)} {...props} />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <h2 data-slot="popover-title" className={cn('text-lg', className)} {...props} />
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return (
    <p
      data-slot="popover-description"
      className={cn('text-base text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
