import { cn } from '@contentops/ui/lib/utils'

/**
 * Фоновое обновление (DESIGN §3.10): полоска 2 px под шапкой поля. Место под неё
 * отведено всегда, поэтому содержимое не сдвигается.
 */
export function RefreshStrip({ active }: { active: boolean }) {
  return (
    <div aria-hidden className="relative h-0.5 shrink-0 overflow-hidden rounded-full">
      <div
        className={cn(
          'absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary/60 transition-opacity duration-160',
          active ? 'animate-[refresh-slide_1.2s_ease-in-out_infinite] opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}
