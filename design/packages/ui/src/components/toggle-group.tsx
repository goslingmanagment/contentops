import type { VariantProps } from 'class-variance-authority'
import { cn } from 'cn'
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui'
import * as React from 'react'
import { toggleVariants } from './toggle'

type ToggleGroupStyle = VariantProps<typeof toggleVariants>

const ToggleGroupContext = React.createContext<ToggleGroupStyle>({
  size: 'default',
  variant: 'default',
})

/**
 * Группа переключателей. `variant="segment"` — серая подложка 36 с белым выбранным
 * сегментом: вид «Крупная плитка · Плитка · Список» (DESIGN §3.2).
 */
function ToggleGroup({
  className,
  variant = 'default',
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & ToggleGroupStyle) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        'flex w-fit items-center gap-1 data-[variant=segment]:gap-0.5 data-[variant=segment]:rounded-lg data-[variant=segment]:bg-secondary data-[variant=segment]:p-0.5',
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & ToggleGroupStyle) {
  const context = React.useContext(ToggleGroupContext)
  const resolvedVariant = variant ?? context.variant
  const resolvedSize = size ?? context.size
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={resolvedVariant}
      data-size={resolvedSize}
      className={cn(
        toggleVariants({ variant: resolvedVariant, size: resolvedSize }),
        resolvedVariant === 'segment' && 'h-8 min-w-8 rounded-md px-1.5',
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  )
}

export { ToggleGroup, ToggleGroupItem }
