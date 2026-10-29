import {
  type Account,
  type AccountCode,
  SURFACE_LABEL,
  type SurfaceKind,
} from '@contentops/contracts'
import { ChoiceChips } from '@contentops/ui/components/choice-chips'
import { cn } from '@contentops/ui/lib/utils'
import { type KeyboardEvent, type ReactNode, useId } from 'react'

interface FieldProps {
  label: string
  children: (labelId: string) => ReactNode
  /** Строка под полем серым: причина недоступных страниц, номера версий. */
  hint?: ReactNode
  className?: string
}

/** Поле окна: подпись 13 серым слева сверху, управление под ней. */
export function Field({ label, children, hint, className }: FieldProps) {
  const labelId = useId()
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <h3 id={labelId} className="text-ink-3 text-sm">
        {label}
      </h3>
      {children(labelId)}
      {hint ? <div className="text-ink-3 text-sm">{hint}</div> : null}
    </section>
  )
}

interface PagePillsProps {
  accounts: readonly Account[]
  value: readonly AccountCode[]
  onChange: (next: AccountCode[]) => void
  /** Почему страница недоступна: «нельзя: второй человек в кадре». */
  disabledReason: (account: Account) => string | null
  labelledBy: string
}

/** «Страницы» — общие чипы, несколько сразу; недоступные серые, причина под ними строкой. */
export function PagePills({
  accounts,
  value,
  onChange,
  disabledReason,
  labelledBy,
}: PagePillsProps) {
  return (
    <ChoiceChips
      multiple
      labelledBy={labelledBy}
      value={value}
      onChange={onChange}
      choices={accounts.map((account) => ({
        value: account.code,
        label: account.label,
        disabledReason: disabledReason(account),
      }))}
    />
  )
}

/** «OF VIP, OF Free — нельзя: второй человек в кадре». */
export function blockedHint(
  accounts: readonly Account[],
  disabledReason: (account: Account) => string | null,
): string | null {
  const blocked = accounts.filter((account) => disabledReason(account) !== null)
  const first = blocked[0]
  if (!first) {
    return null
  }
  return `${blocked.map((account) => account.label).join(', ')} — ${disabledReason(first)}`
}

interface SurfaceChoiceProps {
  surfaces: readonly SurfaceKind[]
  value: SurfaceKind | null
  onChange: (next: SurfaceKind) => void
  labelledBy: string
}

/** «Куда» — стена / фуп / vault / сториз / рассылка, только допустимые. */
export function SurfaceChoice({ surfaces, value, onChange, labelledBy }: SurfaceChoiceProps) {
  return (
    <ChoiceChips
      labelledBy={labelledBy}
      value={value}
      onChange={onChange}
      choices={surfaces.map((surface) => ({ value: surface, label: SURFACE_LABEL[surface] }))}
    />
  )
}

/** `Ctrl Enter` (`⌘ Enter`) — поставить, из любого поля окна (DESIGN §4.13). */
export function submitOnCtrlEnter(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    event.currentTarget.requestSubmit()
  }
}
