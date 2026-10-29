import { cn } from 'cn'
import { CheckIcon } from 'lucide-react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import type * as React from 'react'

/**
 * Галочка 18 px: рамка `--input`, отмеченная — синяя (DESIGN §7.1). Значок стоит в DOM
 * всегда и виден по `data-state`: `CheckboxPrimitive.Indicator` монтируется через
 * `Presence`, который при каждом появлении читает `getComputedStyle`, — в сетке на сотни
 * плиток это съедало кадры прокрутки с выделением.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox relative flex size-4.5 shrink-0 items-center justify-center rounded-sm border border-input bg-background transition-colors duration-120 after:absolute after:-inset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckIcon
        aria-hidden
        data-slot="checkbox-indicator"
        className="invisible size-3.5 stroke-3 text-current group-data-[state=checked]/checkbox:visible"
      />
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
