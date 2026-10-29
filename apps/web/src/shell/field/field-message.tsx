import type { ReactNode } from 'react'

/** Сообщение на месте поля: 403, 404, удалён или слит. */
export function FieldMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  )
}
