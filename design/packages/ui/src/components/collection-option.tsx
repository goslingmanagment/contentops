import { cn } from 'cn'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'

interface CollectionOptionProps {
  id: string
  index: number
  selected: boolean
  focused: boolean
  onItemClick: (index: number, event: MouseEvent) => void
  onItemDoubleClick: (index: number) => void
  className?: string
  style?: CSSProperties
  children: ReactNode
}

/**
 * Элемент виртуальной сетки или списка. Фокус клавиатуры остаётся на самом списке
 * (`aria-activedescendant`), поэтому элемент не фокусируется, а клавиши слушает список.
 * Кольцо фокуса видно, только когда список получил фокус с клавиатуры.
 */
export function CollectionOption({
  id,
  index,
  selected,
  focused,
  onItemClick,
  onItemDoubleClick,
  className,
  style,
  children,
}: CollectionOptionProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиши обрабатывает список-владелец (aria-activedescendant)
    // biome-ignore lint/a11y/useFocusableInteractive: в шаблоне aria-activedescendant фокус держит список, а не элемент
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-focused={focused}
      onClick={(event) => onItemClick(index, event)}
      onDoubleClick={() => onItemDoubleClick(index)}
      style={style}
      className={cn(
        'min-w-0 rounded-xl group-focus-visible/collection:data-[focused=true]:outline-2 group-focus-visible/collection:data-[focused=true]:outline-ring group-focus-visible/collection:data-[focused=true]:outline-offset-2',
        className,
      )}
    >
      {children}
    </div>
  )
}
