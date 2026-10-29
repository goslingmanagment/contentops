import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import { Children, isValidElement, type ReactNode } from 'react'
import { Button } from './button'
import { ItemMenuButton, type ItemMenuModel } from './item-menu'
import { PanelMain, PanelPinArea } from './panel-pin'
import { ScrollArea } from './scroll-area'

const frameWidth = {
  default: 'w-90',
  wide: 'w-100',
  narrow: 'w-80',
} as const

export type PanelFrameWidth = keyof typeof frameWidth

interface PanelFrameProps {
  /** Что открыто: «Кастом «вся в красном»», «Передача PRM-015»; длинное — многоточием. */
  title: ReactNode
  /** Строка под заголовком: состояние словом, ID. */
  subtitle?: ReactNode
  /**
   * Главная кнопка панели и её соседи: стоят под заголовком, вне прокрутки, поэтому
   * всегда в верхней трети (DESIGN §3.4); главная — во всю ширину. Содержимое может
   * положить туда своё и само — через `PanelMain`.
   */
  actions?: ReactNode
  /** «⋯» у заголовка: то же меню, что по правому клику на строке (§3.6). */
  menu?: ItemMenuModel
  onClose: () => void
  /** 400 в заказах и передаче, 360 при окне уже 1320, 320 на минимуме (§3.1). */
  width?: PanelFrameWidth
  /** Подпись панели для чтения с экрана. */
  label: string
  children: ReactNode
  className?: string
}

/**
 * Панель — рабочее место выбранной строки (DESIGN §3.4): тот же блок справа в поле, что
 * и «Сведения», но без вкладок — заголовок, главное действие и разделы. Выезжает за 160 мс.
 */
export function PanelFrame({
  title,
  subtitle,
  actions,
  menu,
  onClose,
  width = 'wide',
  label,
  children,
  className,
}: PanelFrameProps) {
  return (
    <aside
      data-slot="panel-frame"
      aria-label={label}
      className={cn(
        'flex h-full shrink-0 flex-col border-border border-l bg-background duration-160 animate-in fade-in-0 slide-in-from-right-4',
        frameWidth[width],
        className,
      )}
    >
      <header className="flex shrink-0 items-start gap-2 px-5 pt-4 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1.5">
          <h2 className="truncate text-lg" title={textOf(title)}>
            {title}
          </h2>
          {subtitle ? (
            // Строкой из флекса: и слово состояния, и простой текст обрезаются многоточием.
            <div
              className="flex min-w-0 text-sm [&>*]:min-w-0 [&>*]:truncate"
              title={textOf(subtitle)}
            >
              {typeof subtitle === 'string' ? <span>{subtitle}</span> : subtitle}
            </div>
          ) : null}
        </div>
        {menu ? <ItemMenuButton menu={menu} /> : null}
        <Button variant="ghost" size="icon" aria-label="Закрыть панель" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <PanelPinArea>
        {actions ? <PanelMain>{actions}</PanelMain> : null}
        <ScrollArea className="min-h-0 flex-1 border-border border-t">
          <div className="flex flex-col gap-5 px-5 pt-4 pb-6">{children}</div>
        </ScrollArea>
      </PanelPinArea>
    </aside>
  )
}

interface PanelMessageProps {
  /** «CUS-231 у Лоры нет», «Такой группы у Лоры нет». */
  children: ReactNode
  label: string
  onClose: () => void
  width?: PanelFrameWidth
}

/**
 * Строки из адреса нет (DESIGN §3.10): одна серая строка на месте панели, без ▲ и без
 * «Повторить» — повторять нечего. Для экранов-сущностей (объект, подборка, канал) —
 * `NotFoundState` на всё поле.
 */
export function PanelMessage({ children, label, onClose, width = 'wide' }: PanelMessageProps) {
  return (
    <aside
      data-slot="panel-message"
      aria-label={label}
      className={cn(
        'flex h-full shrink-0 flex-col border-border border-l bg-background duration-160 animate-in fade-in-0 slide-in-from-right-4',
        frameWidth[width],
      )}
    >
      <div className="flex items-start gap-2 px-5 pt-4">
        <p className="min-w-0 flex-1 pt-2 text-base text-muted-foreground">{children}</p>
        <Button variant="ghost" size="icon" aria-label="Закрыть панель" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    </aside>
  )
}

/** Текст подписи для подсказки: строки и числа из дерева, без разметки. */
function textOf(node: ReactNode): string | undefined {
  const parts: string[] = []
  const walk = (child: ReactNode) => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child))
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      Children.forEach(child.props.children, walk)
    }
  }
  Children.forEach(node, walk)
  const text = parts.join('').trim()
  return text || undefined
}
