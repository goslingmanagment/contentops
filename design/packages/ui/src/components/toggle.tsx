import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { Toggle as TogglePrimitive } from 'radix-ui'
import type * as React from 'react'

/** Переключатель-кнопка; в группе вида — сегмент с белой подложкой у выбранного. */
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium text-base text-muted-foreground transition-colors duration-120 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  {
    variants: {
      variant: {
        default: 'hover:bg-accent data-[state=on]:bg-secondary data-[state=on]:text-foreground',
        segment: 'data-[state=on]:bg-background data-[state=on]:text-foreground',
      },
      size: {
        default: 'h-9 min-w-9 px-2.5',
        sm: 'h-7.5 min-w-7.5 rounded-md px-2 [&_svg:not([class*=size-])]:size-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Toggle({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
