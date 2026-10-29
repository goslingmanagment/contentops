import { cn } from 'cn'
import { XIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './button'
import { PanelPinArea } from './panel-pin'
import { ScrollArea } from './scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'

export interface InfoPanelTab {
  value: string
  label: string
  content: ReactNode
}

const panelWidth = {
  default: 'w-90',
  wide: 'w-100',
  narrow: 'w-80',
} as const

interface InfoPanelProps {
  /** «Сведения / История». */
  tabs: readonly InfoPanelTab[]
  value?: string
  onValueChange?: (value: string) => void
  onClose: () => void
  /** 360 обычно, 400 в «Приехало» и «Сверить», 320 при окне 1280 (§3.1). */
  width?: keyof typeof panelWidth
  className?: string
}

/**
 * Панель сведений (DESIGN §3.4): обычный блок фиксированной ширины справа в поле, слева
 * линия. Не всплывает поверх, а сужает содержимое. Выезжает за 160 мс. У вкладки — свой
 * закреплённый верх: `PanelHead` и `PanelMain` из содержимого встают под вкладки, вне
 * прокрутки.
 */
export function InfoPanel({
  tabs,
  value,
  onValueChange,
  onClose,
  width = 'default',
  className,
}: InfoPanelProps) {
  return (
    <aside
      data-slot="info-panel"
      aria-label="Сведения"
      className={cn(
        'flex h-full shrink-0 flex-col border-border border-l bg-background duration-160 animate-in fade-in-0 slide-in-from-right-4',
        panelWidth[width],
        className,
      )}
    >
      <Tabs
        value={value}
        defaultValue={value === undefined ? tabs[0]?.value : undefined}
        onValueChange={onValueChange}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <TabsList>
            {tabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button variant="ghost" size="icon" aria-label="Закрыть сведения" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="flex min-h-0 flex-col">
            {/* Закреплённый верх отделён линией; без него содержимое начинается сразу. */}
            <PanelPinArea className="mb-3 border-border border-b">
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-5 px-5 pt-1 pb-6">{tab.content}</div>
              </ScrollArea>
            </PanelPinArea>
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  )
}

interface InfoSectionProps {
  title: string
  /** Итог или действие справа от заголовка: «4 из 5 страниц», «Подтвердить всю разметку». */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

/** Раздел панели: заголовок 13/18 серым и содержимое; разделы отделены линией. */
export function InfoSection({ title, aside, children, className }: InfoSectionProps) {
  return (
    <section
      className={cn(
        'flex flex-col gap-2.5 border-border border-t pt-4 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <header className="flex min-h-5 items-center justify-between gap-3">
        <h3 className="text-ink-3 text-sm">{title}</h3>
        {aside ? <div className="flex shrink-0 items-center text-sm">{aside}</div> : null}
      </header>
      {children}
    </section>
  )
}
