import { cn } from 'cn'
import type * as React from 'react'

/** Клавиша 12/16 в рамке, как на клавиатуре (DESIGN §3.12). */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-sm border border-line-strong border-b-2 bg-background px-1.5 font-sans font-medium text-muted-foreground text-xs select-none in-data-[slot=tooltip-content]:border-border in-data-[slot=tooltip-content]:bg-transparent in-data-[slot=tooltip-content]:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
