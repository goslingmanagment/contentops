import { cn } from '@contentops/ui/lib/utils'

/** Логотип над колонкой (DESIGN §2.1): значок 24 и слово 15/600. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('flex h-16 items-center gap-2.5', compact ? 'justify-center' : 'px-5')}>
      <svg viewBox="0 0 24 24" aria-hidden className="size-6 shrink-0">
        <rect width="24" height="24" rx="6" className="fill-primary" />
        <rect
          x="7.25"
          y="7.25"
          width="9.5"
          height="9.5"
          rx="2.25"
          fill="none"
          strokeWidth="2"
          className="stroke-primary-foreground"
        />
      </svg>
      {compact ? (
        <span className="sr-only">ContentOps</span>
      ) : (
        <span className="text-md">ContentOps</span>
      )}
    </div>
  )
}
