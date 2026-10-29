import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { Slot } from 'radix-ui'
import type * as React from 'react'

/**
 * Кнопка (DESIGN §7.1, §7.3, §8). Синяя `default` — одна на экран; кнопки в строках —
 * `outline`; `bar` — прозрачная в тёмной полосе выделения, где `default` становится белой.
 * Высоты: 36 (`default`), 30 (`sm`), 44 (`lg`, «Загрузить»).
 */
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent font-medium text-base transition-colors duration-120 select-none disabled:pointer-events-none disabled:opacity-50 aria-busy:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary-hover aria-expanded:bg-secondary-hover',
        outline:
          'border-line-strong bg-background text-foreground hover:bg-accent aria-expanded:bg-accent',
        ghost:
          'text-foreground hover:bg-accent aria-expanded:bg-accent [&_svg:not([class*=text-])]:text-muted-foreground',
        bar: 'text-foreground hover:bg-accent aria-expanded:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'h-auto rounded-sm px-0 text-primary-ink underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-7.5 gap-1.5 rounded-md px-2.5 text-sm [&_svg:not([class*=size-])]:size-4',
        lg: 'h-11 rounded-xl px-4 text-md [&_svg:not([class*=size-])]:size-5',
        icon: 'size-9',
        'icon-sm': 'size-7.5 rounded-md [&_svg:not([class*=size-])]:size-4',
        'icon-lg': 'size-11 rounded-xl',
        inline: 'h-auto p-0',
      },
    },
    compoundVariants: [
      { variant: 'link', size: 'default', className: 'h-auto px-0' },
      { variant: 'link', size: 'sm', className: 'h-auto px-0' },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Запрос в пути: вместо подписи «…», кнопка заблокирована (DESIGN §3.8). С `asChild` не действует. */
    pending?: boolean
  }

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  pending = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : 'button'
  const showPending = pending && !asChild
  return (
    <Component
      data-slot="button"
      data-variant={variant}
      data-size={size}
      aria-busy={showPending || undefined}
      disabled={asChild ? undefined : disabled || showPending}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {showPending ? <PendingLabel>{children}</PendingLabel> : children}
    </Component>
  )
}

/** Держит ширину кнопки прежней, пока вместо подписи стоит «…». */
function PendingLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="invisible inline-flex items-center gap-[inherit]">{children}</span>
      <span aria-hidden className="absolute inset-0 flex items-center justify-center">
        …
      </span>
    </>
  )
}

export type { ButtonProps }
export { Button, buttonVariants }
