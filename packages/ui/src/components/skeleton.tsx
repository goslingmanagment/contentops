import { cn } from 'cn'
import type * as React from 'react'

/** Серая заготовка на месте ещё не пришедших данных (DESIGN §3.10). */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn('animate-pulse rounded-lg bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
