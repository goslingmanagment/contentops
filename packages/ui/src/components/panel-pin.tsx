import { cn } from 'cn'
import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Закреплённый верх панели (DESIGN §3.4): заголовок выбранного и главная кнопка стоят вне
 * прокрутки, поэтому всегда в верхней трети. Панель (`InfoPanel`, `PanelFrame`) держит два
 * места, а содержимое панели кладёт туда своё через `PanelHead` и `PanelMain` — там, где
 * оно и собирается, без подъёма состояния наверх.
 */
interface PanelPinTargets {
  head: HTMLElement | null
  main: HTMLElement | null
}

const PanelPinContext = createContext<PanelPinTargets | null>(null)

/** Места под заголовок и главную кнопку; пустые не занимают высоты. */
export function PanelPinArea({ children, className }: { children: ReactNode; className?: string }) {
  const [head, setHead] = useState<HTMLElement | null>(null)
  const [main, setMain] = useState<HTMLElement | null>(null)
  return (
    <PanelPinContext value={{ head, main }}>
      <div
        data-slot="panel-pin"
        className={cn(
          // Оба места пусты — области нет вовсе.
          'flex shrink-0 flex-col gap-3 px-5 pb-4 [&:not(:has(>:not(:empty)))]:hidden',
          className,
        )}
      >
        <div ref={setHead} data-slot="panel-head" className="flex min-w-0 flex-col empty:hidden" />
        <div
          ref={setMain}
          data-slot="panel-main"
          // Главная кнопка — во всю ширину, соседние делят строку под ней поровну.
          className="flex flex-wrap gap-2 empty:hidden [&>*]:min-w-0 [&>*]:flex-1 [&>*:first-child]:basis-full"
        />
      </div>
      {children}
    </PanelPinContext>
  )
}

function Pinned({ target, children }: { target: keyof PanelPinTargets; children: ReactNode }) {
  const targets = useContext(PanelPinContext)
  if (!targets) {
    return <>{children}</>
  }
  const element = targets[target]
  return element ? createPortal(children, element) : null
}

/** Заголовок выбранного в закреплённом верху панели. */
export function PanelHead({ children }: { children: ReactNode }) {
  return <Pinned target="head">{children}</Pinned>
}

/**
 * Главная кнопка панели и её соседи: первая — во всю ширину, остальные делят строку под
 * ней. Вне панели рисуется на месте.
 */
export function PanelMain({ children }: { children: ReactNode }) {
  return <Pinned target="main">{children}</Pinned>
}

interface PanelTitleProps {
  title: string
  /** Строки под заголовком: ID, страница и время; каждая обрезается многоточием. */
  lines?: readonly ReactNode[]
  /** «⋯» у заголовка. */
  menu?: ReactNode
  /** Строка состояния под заголовком: ◆ «Hub нашёл похожее». */
  status?: ReactNode
}

/**
 * Заголовок в закреплённом верху: название 16/22 в две строки, полный текст — в
 * подсказке; строки под ним — в одну строку с многоточием.
 */
export function PanelTitle({ title, lines = [], menu, status }: PanelTitleProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="line-clamp-2 text-lg" title={title}>
            {title}
          </h2>
          {lines.map((line, index) => (
            // Строки заданы по порядку и не переставляются: ключ — место в списке.
            <p key={index} className="truncate text-ink-3 text-sm tabular-nums">
              {line}
            </p>
          ))}
        </div>
        {menu ? <div className="-mt-1 -mr-2 shrink-0">{menu}</div> : null}
      </div>
      {status}
    </div>
  )
}
