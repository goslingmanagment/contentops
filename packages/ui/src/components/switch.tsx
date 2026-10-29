import { cn } from 'cn'
import { Switch as SwitchPrimitive } from 'radix-ui'
import type * as React from 'react'

/**
 * Выключатель (DESIGN §7.1): выключенный — `--input`, включённый — тёмный `--foreground`.
 * Синий — только у одной главной кнопки экрана, поэтому 21 выключатель Интеграций не
 * спорит с ней за взгляд.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-120 after:absolute after:-inset-2 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-foreground data-unchecked:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background transition-transform duration-120 data-checked:translate-x-4 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
