import { Button } from '@contentops/ui/components/button'
import {
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import type { ReactNode } from 'react'
import { CheckLine, type CheckSummary } from './check-line'

interface DialogLayoutProps {
  title: string
  description: string
  /** «Строка / Выпуск PPV» справа от заголовка. */
  tabs?: ReactNode
  /** Левая колонка 260: объект, список выбранных или поиск. */
  left: ReactNode
  /** Правая колонка: поля формы. */
  children: ReactNode
  check: CheckSummary | null
  /** Место под строку проверки: две строки, когда страниц несколько. */
  checkLines?: 1 | 2
  /** «PPV-076 · 3 страницы · стена · чт 24.09, 20:00 · Диана». */
  summary: string
  /** Главная кнопка: «Поставить 3», «Поставить выпуск: 14 строк». */
  submit: ReactNode
}

/**
 * Раскладка окна «В план» (DESIGN §4.13, 760 × до 640): заголовок с вкладками, две
 * колонки, внизу одна строка проверки, итог словами и кнопка. Прокручиваются колонки,
 * низ окна стоит на месте.
 */
export function DialogLayout({
  title,
  description,
  tabs,
  left,
  children,
  check,
  checkLines = 1,
  summary,
  submit,
}: DialogLayoutProps) {
  return (
    <>
      <DialogHeader className="flex-row items-center gap-4 px-6 pt-5 pb-4">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {tabs}
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] border-border border-t">
        <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-border border-r px-6 py-5">
          {left}
        </aside>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-5">{children}</div>
      </div>
      <footer className="flex flex-col gap-3 border-border border-t px-6 py-4">
        <CheckLine summary={check} lines={checkLines} />
        <div className="flex items-center gap-3">
          <p className="line-clamp-2 min-w-0 flex-1 text-pretty text-muted-foreground text-sm">
            {summary}
          </p>
          <DialogClose asChild>
            <Button type="button" variant="ghost">
              Отмена
            </Button>
          </DialogClose>
          {submit}
        </div>
      </footer>
    </>
  )
}
