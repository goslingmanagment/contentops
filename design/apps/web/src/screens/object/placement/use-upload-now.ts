import {
  type Account,
  type DownloadAnswer,
  type ItemType,
  newIdempotencyKey,
  type SurfaceKind,
  type UploadNowResult,
} from '@contentops/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys } from '@/data/object'
import { planChangedKeys, usePlanCommands } from '@/data/plan'
import { useObjectPage } from '../object-context'

/** «Залить сейчас»: PPV, секстинги и лайф — в vault, сеты — на стену (DESIGN §4.4). */
const UPLOAD_SURFACE: Partial<Record<ItemType, SurfaceKind>> = {
  ppv: 'vault',
  sexting: 'vault',
  life: 'vault',
  set: 'wall',
}

export function uploadNowSurface(type: ItemType): SurfaceKind | undefined {
  return UPLOAD_SURFACE[type]
}

interface RowDownload {
  account: Account
  rowId: string
}

/**
 * Заливка на одну страницу из объекта (DESIGN §4.4, сценарии §6.1, §6.5). «Залить сейчас»
 * ставит строку плана на сегодня и начинает скачивание «Для заливки» с кодом страницы
 * в имени; «Скачать» делает то же для строки, которая уже стоит. Готовая копия уходит
 * браузеру и полоска «Скачано · Fansly 2 · Отметить залитым»; долгая копия собирается в
 * лотке, файл и полоска приходят, когда она готова, даже если человек ушёл со страницы.
 */
export function usePageUpload() {
  const { detail, model } = useObjectPage()
  const api = useApi()
  const plan = usePlanCommands(model.code)
  const toast = useActionToast()
  const deliverDownload = useDeliverDownload()
  const queryClient = useQueryClient()
  const changed = () => [
    ...itemQueryKeys(model.code, detail.entry.id),
    ...planChangedKeys(model.code),
  ]

  // Отметка приходит и из полоски, которая живёт дольше панели и страницы объекта:
  // поэтому без хука мутации — только клиент API, кэш запросов и полоска оболочки.
  const [marking, setMarking] = useState(false)
  const refresh = () => {
    for (const queryKey of changed()) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }
  const unmark = (row: string, key = newIdempotencyKey()) => {
    plan.unmark({ key, row }).then(
      () => {
        refresh()
        toast.show({ message: 'Отметка снята' })
      },
      (error: unknown) =>
        toast.showFailure(error, { failed: 'Отметка не снялась', retry: () => unmark(row, key) }),
    )
  }
  const mark = (target: RowDownload, key = newIdempotencyKey()) => {
    setMarking(true)
    plan
      .mark({ key, row: target.rowId, kind: 'posted', at: null })
      .then(
        (row) => {
          refresh()
          toast.show({
            message: `Отмечено · залито на ${target.account.label}`,
            action: { label: 'Отменить', onSelect: () => unmark(row.id) },
            undoable: true,
          })
        },
        (error: unknown) =>
          toast.showFailure(error, { failed: 'Не отметилось', retry: () => mark(target, key) }),
      )
      .finally(() => setMarking(false))
  }

  const downloaded = (target: RowDownload) =>
    toast.show({
      message: `Скачано · ${target.account.label}`,
      action: { label: 'Отметить залитым', onSelect: () => mark(target) },
    })

  const deliver = (answer: DownloadAnswer, target: RowDownload, message: string) => {
    if (answer.kind === 'operation') {
      toast.show({ message })
    }
    deliverDownload(model.code, [answer], {
      building: `Для ${target.account.label} · ${detail.entry.id}`,
      onSaved: () => downloaded(target),
      onFailed: () =>
        toast.show({ message: `Копия для ${target.account.label} не собралась`, tone: 'error' }),
    })
  }

  const uploadNow = useIntentMutation<Account, UploadNowResult>({
    failed: 'Не началось',
    run: (account, idempotencyKey) =>
      api.objects.uploadNow({
        params: { model: model.code, id: detail.entry.id },
        body: { account: account.code, surface: uploadNowSurface(detail.entry.type) ?? 'vault' },
        idempotencyKey,
      }),
    invalidates: changed,
    onSuccess: ({ row, download }, account) =>
      deliver(
        download,
        { account, rowId: row.id },
        `Строка на сегодня · копия для ${account.label} собирается`,
      ),
  })

  const download = useIntentMutation<RowDownload, DownloadAnswer>({
    failed: 'Не скачалось',
    run: ({ account, rowId }, idempotencyKey) =>
      api.objects.download({
        params: { model: model.code, id: detail.entry.id },
        body: { kind: 'platform', strip_metadata: true, account: account.code, plan_row: rowId },
        idempotencyKey,
      }),
    invalidates: () => itemQueryKeys(model.code, detail.entry.id),
    onSuccess: (answer, target) =>
      deliver(answer, target, `Копия для ${target.account.label} собирается`),
  })

  return {
    uploadNow: uploadNow.start,
    uploadingNow: uploadNow.isPending,
    download: download.start,
    downloading: download.isPending,
    mark: (target: RowDownload) => mark(target),
    marking,
  }
}
