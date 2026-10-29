import { cn } from 'cn'
import { Slot } from 'radix-ui'
import { type ComponentProps, createContext, useContext } from 'react'

/**
 * Тёмное поддерево (DESIGN §7.1): полоса выделения, просмотр и полоска после действия.
 * Внутри действует набор токенов `.dark`. Меню и всплывашки уходят в портал вне
 * поддерева, поэтому узнают о нём из контекста и сами надевают `.dark`.
 */
const DarkSurfaceContext = createContext(false)

type DarkSurfaceProps = ComponentProps<'div'> & { asChild?: boolean }

export function DarkSurface({ asChild = false, className, ...props }: DarkSurfaceProps) {
  const Component = asChild ? Slot.Root : 'div'
  return (
    <DarkSurfaceContext.Provider value>
      <Component data-surface="dark" className={cn('dark text-foreground', className)} {...props} />
    </DarkSurfaceContext.Provider>
  )
}

/** Класс для содержимого в портале: `dark`, если вызвано изнутри тёмного поддерева. */
export function useSurfaceClass(): string | undefined {
  return useContext(DarkSurfaceContext) ? 'dark' : undefined
}
