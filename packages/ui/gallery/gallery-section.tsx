import { cn } from 'cn'
import type { ReactNode } from 'react'
import { useHashRoute } from './use-hash-route'

interface GallerySectionProps {
  title: string
  note?: string
  children: ReactNode
  className?: string
}

/** Раздел галереи: белое поле или, с `?bg=canvas`, серый холст колонки. */
export function GallerySection({ title, note, children, className }: GallerySectionProps) {
  const onCanvas = useHashRoute().includes('bg=canvas')
  return (
    <section
      className={cn(
        'flex flex-col gap-4 rounded-3xl px-7 pt-5 pb-7',
        onCanvas ? 'border border-line-strong border-dashed' : 'bg-background',
        className,
      )}
    >
      <header className="flex items-baseline gap-3">
        <h2 className="text-lg">{title}</h2>
        {note ? <p className="text-ink-3 text-sm">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

/** Подпись образца внутри раздела. */
export function Specimen({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p className="text-ink-3 text-xs">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}
