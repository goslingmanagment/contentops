import { cn } from 'cn'
import { Progress as ProgressPrimitive } from 'radix-ui'
import type * as React from 'react'

/** Тонкая полоска хода: 4 px по умолчанию, 2 px у серого слова «готовится» (`className="h-0.5"`). */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const percent = Math.min(100, Math.max(0, value ?? 0))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('relative h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full rounded-full bg-primary transition-transform duration-160"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
