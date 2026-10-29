import { Button } from '@contentops/ui/components/button'
import { Input } from '@contentops/ui/components/input'
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@contentops/ui/components/popover'
import { type FormEvent, type ReactNode, useId, useState } from 'react'

interface RejectPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Куда деть фокус после закрытия; по умолчанию — на кнопку, которая открыла. */
  onCloseAutoFocus?: (event: Event) => void
  onReject: (reason: string | null) => void
  /** «Отклонить» или «Отклонить 3». */
  submitLabel?: string
  align?: 'start' | 'end'
  /** Всплывашка открывается из меню «⋯»: элемент только держит место, а не открывает её. */
  anchorOnly?: boolean
  children: ReactNode
}

/**
 * «Отклонить…» (DESIGN §2.5): причина по желанию, без окна «Вы уверены?». Вернуть в
 * работу можно 30 дней — из полоски или из «Решённого».
 */
export function RejectPopover({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onReject,
  submitLabel = 'Отклонить',
  align = 'start',
  anchorOnly = false,
  children,
}: RejectPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchorOnly ? (
        <PopoverAnchor asChild>{children}</PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      <PopoverContent align={align} className="w-80" onCloseAutoFocus={onCloseAutoFocus}>
        {open ? (
          <RejectForm
            submitLabel={submitLabel}
            onReject={(reason) => {
              onOpenChange(false)
              onReject(reason)
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function RejectForm({
  submitLabel,
  onReject,
}: {
  submitLabel: string
  onReject: (reason: string | null) => void
}) {
  const [reason, setReason] = useState('')
  const inputId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onReject(reason.trim() || null)
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor={inputId} className="text-ink-3 text-sm">
        Причина, если есть
      </label>
      <Input
        id={inputId}
        autoFocus
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="не контент: скриншот"
      />
      <Button type="submit" variant="outline" className="self-start">
        {submitLabel}
      </Button>
    </form>
  )
}
