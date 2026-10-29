import { cn } from 'cn'
import type * as React from 'react'

/** Поле ввода 36: рамка `--input`, в фокусе синяя (DESIGN §7.1, §7.3). */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none transition-colors duration-120 placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
