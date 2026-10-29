import { cn } from 'cn'
import type { ReactNode } from 'react'
import { Skeleton } from './skeleton'

interface SettingsSectionProps {
  /** «Сессии», «Agency Hub», «Очереди»; без заголовка — продолжение раздела выше. */
  title?: string
  /** Серая строка под заголовком — только факт, без пересказа нормы. */
  description?: ReactNode
  /** Справа от заголовка: «Добавить страницу», подписи колонок выключателей. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Раздел формы настроек (DESIGN §4.19, §8 `SettingsLayout` и формы): заголовок 16/22 и
 * строки через тонкую линию, как в настройках облачного диска. Плоско, без карточек.
 */
export function SettingsSection({
  title,
  description,
  aside,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section data-slot="settings-section" className={cn('flex flex-col', className)}>
      {title || aside ? (
        <header className="flex min-h-10 items-end gap-4 pb-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title ? <h2 className="text-lg">{title}</h2> : null}
            {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
          </div>
          {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
        </header>
      ) : null}
      <div className="flex flex-col divide-y divide-border border-border border-t">{children}</div>
    </section>
  )
}

interface SettingsRowProps {
  /** Что настраивается: «Fansly 2», «Допуск времени», «Chrome на Mac». */
  label: ReactNode
  /** Вторая строка серым: код, состояние, срок. */
  detail?: ReactNode
  /** Управление справа: выключатель, значение, кнопка. */
  children?: ReactNode
  /** Раскрытие под строкой: история прав, форма «Настроить». */
  below?: ReactNode
  className?: string
}

/** Строка настроек: слева что, справа управление; высота от 56, не прыгает при правке. */
export function SettingsRow({ label, detail, children, below, className }: SettingsRowProps) {
  return (
    <div data-slot="settings-row" className={cn('flex flex-col', className)}>
      <div className="flex min-h-14 items-center gap-6 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="min-w-0 truncate text-base">{label}</div>
          {detail ? (
            <div className="min-w-0 truncate text-muted-foreground text-sm">{detail}</div>
          ) : null}
        </div>
        {children ? <div className="flex shrink-0 items-center gap-3">{children}</div> : null}
      </div>
      {below}
    </div>
  )
}

/** Заготовка раздела настроек ровно по высотам строк (§3.10). */
export function SettingsSectionSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      <Skeleton className="mt-3 mb-4 h-4 w-32 rounded-sm" />
      {Array.from({ length: rows }, (_, index) => (
        <div
          // Заготовки одинаковы и не переставляются.
          key={index}
          className="flex h-14 items-center gap-6 border-border border-t"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40 rounded-sm" />
            <Skeleton className="h-3 w-64 rounded-sm" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
      ))}
    </div>
  )
}
