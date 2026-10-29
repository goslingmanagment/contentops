import { hashString } from '@contentops/contracts'
import { cn } from '@contentops/ui/lib/utils'

/**
 * Тёплые градиенты семейств обложек (DESIGN §7.9) — аватар модели без фото. Классы
 * записаны целиком, чтобы Tailwind их увидел.
 */
const AVATAR_GRADIENTS = [
  'from-(--cover-party-light) to-(--cover-party-dark)',
  'from-(--cover-bedroom-light) to-(--cover-bedroom-dark)',
  'from-(--cover-lace-light) to-(--cover-lace-dark)',
  'from-(--cover-evening-light) to-(--cover-evening-dark)',
  'from-(--cover-kitchen-light) to-(--cover-kitchen-dark)',
] as const

interface ModelAvatarProps {
  /** Код модели: от него зависит градиент. */
  code: string
  name: string
  /** Точка, если у модели есть ◆ или ▲ (DESIGN §2.2). */
  attention?: boolean
  size?: 'default' | 'small'
}

/** Аватар модели: первая буква на тёплом градиенте. */
export function ModelAvatar({ code, name, attention = false, size = 'default' }: ModelAvatarProps) {
  const gradient = AVATAR_GRADIENTS[hashString(code) % AVATAR_GRADIENTS.length]
  return (
    <span className={cn('relative shrink-0', size === 'default' ? 'size-9' : 'size-7')}>
      <span
        aria-hidden
        className={cn(
          'flex size-full items-center justify-center rounded-full bg-linear-to-br font-semibold text-scrim-foreground [text-shadow:0_1px_2px_var(--scrim)]',
          gradient,
          size === 'default' ? 'text-base' : 'text-sm',
        )}
      >
        {name.charAt(0)}
      </span>
      {attention ? (
        <span
          role="img"
          aria-label="есть дела"
          className={cn(
            'absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-attention ring-2',
            size === 'default' ? 'ring-sidebar' : 'ring-popover',
          )}
        />
      ) : null}
    </span>
  )
}
