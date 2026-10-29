import type { AcceptResult, ItemId, MakePpvResult } from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useWhenOperationEnds } from '@/actions/when-operation-ends'
import { itemQueryKeys } from '@/data/object'
import { acceptedMessage } from '@/screens/inbox/shared/accept-texts'
import { useCurrentModel } from '@/shell/model/model-context'
import { useUploads } from '@/shell/upload/upload-context'

/**
 * После «Создать PPV» (DESIGN §3.8): номер выдан и не освобождается, поэтому отмены нет.
 * Полоска по общей формуле «Действие · что · Кнопка», как после «Принять»: «Принято →
 * PPV-077 · Открыть · Добавить тизер» — следующий шаг кнопкой, 6 с. Свой монтаж — загрузка
 * с целью «PPV из CUS-195» (§3.7): она идёт в лотке, номера до проверки нет; когда проверка
 * прошла, PPV принимается сам и приходит полоска «Принято → PPV-077 · Открыть».
 */
export function useCreatedPpv(source: ItemId, onDone: () => void) {
  const model = useCurrentModel().code
  const toast = useActionToast()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { openUploadDialog, trackOperation } = useUploads()
  const whenEnds = useWhenOperationEnds()
  return useCallback(
    (result: AcceptResult | MakePpvResult) => {
      const refresh = () => {
        for (const queryKey of itemQueryKeys(model, source)) {
          void queryClient.invalidateQueries({ queryKey })
        }
      }
      const accepted = (accept: AcceptResult) => {
        const openItem = () =>
          void navigate({ to: '/$model/i/$id', params: { model, id: accept.item_id } })
        const open = { label: 'Открыть', onSelect: openItem }
        toast.show(
          accept.next_step === 'Добавить тизер'
            ? {
                message: acceptedMessage(accept),
                secondaryAction: open,
                action: {
                  label: accept.next_step,
                  onSelect: () => {
                    openItem()
                    openUploadDialog([], {
                      target: { kind: 'item', itemId: accept.item_id, title: accept.item_id },
                      kind: 'teaser',
                    })
                  },
                },
              }
            : { message: acceptedMessage(accept), action: open },
        )
      }
      refresh()
      onDone()
      if (!('operation_id' in result)) {
        accepted(result)
        return
      }
      trackOperation(model, result.operation_id, `Монтаж → PPV из ${source}`)
      toast.show({ message: `Монтаж загружается → PPV из ${source} · номер после проверки` })
      whenEnds(model, result.operation_id, (operation) => {
        refresh()
        const id = operation.result?.item_id
        if (operation.state === 'done' && id) {
          accepted({ item_id: id, how: 'new', next_step: null })
          return
        }
        // Проверка не прошла: загрузка лежит в «Приехало» с ▲ (§3.7).
        toast.show({
          tone: 'error',
          message: `Монтаж для PPV из ${source} не принят · проверка не прошла`,
          action: {
            label: 'Приехало',
            onSelect: () => void navigate({ to: '/$model/inbox', params: { model } }),
          },
          durationMs: 10_000,
        })
      })
    },
    [
      model,
      navigate,
      onDone,
      openUploadDialog,
      queryClient,
      source,
      toast,
      trackOperation,
      whenEnds,
    ],
  )
}
