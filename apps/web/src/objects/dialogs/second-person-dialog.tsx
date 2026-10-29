import {
  type BatchResult,
  formatNumber,
  type ItemId,
  isApiError,
  plural,
} from '@contentops/contracts'
import { Button } from '@contentops/ui/components/button'
import { type Choice, ChoiceChips } from '@contentops/ui/components/choice-chips'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentops/ui/components/dialog'
import { StatusSign } from '@contentops/ui/components/status-sign'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { z } from 'zod'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys } from '@/data/object'
import { useCurrentModel } from '@/shell/model/model-context'
import { batchMessage } from '../batch-message'

const RowsDetailsSchema = z.object({ rows: z.number().int().positive() })

type Mark = 'yes' | 'no'

const MARK_CHOICES: readonly Choice<Mark>[] = [
  { value: 'yes', label: 'Есть второй человек' },
  { value: 'no', label: 'Второго человека нет' },
]

interface SecondPersonDialogProps {
  items: readonly ItemId[]
  /** Что уже решено (переключатель в объекте); без него человек выбирает в окне. */
  value?: boolean
  /** Строк на OnlyFans, которые снимутся, — если сервер уже сказал это (422). */
  rows?: number
  onClose: () => void
}

function rowsWord(rows: number): string {
  return `${formatNumber(rows)} ${plural(rows, ['строку', 'строки', 'строк'])}`
}

/**
 * «Второй человек в кадре» (DESIGN §3.9): одно из трёх окон подтверждения. Поздняя отметка
 * снимает строки плана на OnlyFans — до нажатия видно, сколько: «Снимет 2 строки на
 * OnlyFans · Снять и отметить». Отменить нельзя.
 */
export function SecondPersonDialog({ items, value, rows, onClose }: SecondPersonDialogProps) {
  const model = useCurrentModel().code
  const api = useApi()
  const toast = useActionToast()
  const queryClient = useQueryClient()
  const [mark, setMark] = useState<Mark | null>(value === undefined ? null : value ? 'yes' : 'no')
  const [blockedRows, setBlockedRows] = useState(rows ?? 0)
  const secondPerson = mark === 'yes'

  const apply = useIntentMutation<{ consent: boolean }, BatchResult>({
    failed: 'Не отметилось',
    run: ({ consent }, idempotencyKey) =>
      api.objectBatch.secondPerson({
        params: { model },
        body: { items: [...items], second_person: secondPerson, cancel_onlyfans_rows: consent },
        idempotencyKey,
      }),
    handleFailure: (error) => {
      const details = isApiError(error) ? RowsDetailsSchema.safeParse(error.body.details) : null
      if (!details?.success) {
        return false
      }
      setBlockedRows(details.data.rows)
      return true
    },
    onSuccess: (result) => {
      for (const id of items) {
        for (const queryKey of itemQueryKeys(model, id)) {
          void queryClient.invalidateQueries({ queryKey })
        }
      }
      onClose()
      toast.show({
        message: batchMessage(result, secondPerson ? 'Отмечено' : 'Отметка снята'),
      })
    },
  })

  const needsConsent = secondPerson && blockedRows > 0
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-120">
        <DialogHeader>
          <DialogTitle>Второй человек в кадре</DialogTitle>
          <DialogDescription>
            {items.length === 1
              ? items[0]
              : `Выбрано ${formatNumber(items.length)} ${plural(items.length, ['объект', 'объекта', 'объектов'])}`}
          </DialogDescription>
        </DialogHeader>
        {value === undefined ? (
          <ChoiceChips label="Отметка" choices={MARK_CHOICES} value={mark} onChange={setMark} />
        ) : null}
        {needsConsent ? (
          <p className="flex items-start gap-2 rounded-xl bg-destructive-bg px-3 py-2.5 text-base">
            <StatusSign kind="trouble" className="mt-0.5" />
            <span>Снимет {rowsWord(blockedRows)} на OnlyFans</span>
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant={needsConsent ? 'destructive' : 'default'}
            disabled={mark === null}
            pending={apply.isPending}
            onClick={() => apply.start({ consent: needsConsent })}
          >
            {needsConsent ? 'Снять и отметить' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
