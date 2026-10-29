import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { Slot } from 'radix-ui'
import type * as React from 'react'

/**
 * Метка 12/16 с радиусом 6 (DESIGN §7.2, §7.4): роль файла, «ИИ», «обр.», «v1».
 * Цветные варианты — только там, где цвет что-то значит (§5).
 */
const badgeVariants = cva(
  'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-sm border border-transparent px-1.5 font-medium text-xs [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border-line-strong text-muted-foreground',
        tint: 'bg-primary-tint text-primary-ink',
        attention: 'bg-attention-bg text-attention-ink',
        destructive: 'bg-destructive-bg text-destructive',
        scrim: 'bg-scrim text-2xs text-scrim-foreground',
      },
    },
    defaultVariants: {
      variant: 'secondary',
    },
  },
)

function Badge({
  className,
  variant = 'secondary',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : 'span'
  return (
    <Component
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
