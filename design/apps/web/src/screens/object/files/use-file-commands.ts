import type {
  BuildFypVersionsCommand,
  DownloadAnswer,
  ItemCreated,
  LifeAssignment,
  MakeCoverCommand,
  OperationAccepted,
  RawPurpose,
} from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { itemQueryKeys } from '@/data/object'
import { filesWord } from '@/lib/words'
import { useUploads } from '@/shell/upload/upload-context'
import { useItemCommand } from '../actions/use-item-command'
import { useObjectPage } from '../object-context'
import { useFileSelection } from './file-selection'
import { usePendingOperations } from './pending-operations'

/** Адрес объекта и клиент — у всех команд файлов одни. */
function useTarget() {
  const { detail, model } = useObjectPage()
  return { api: useApi(), params: { model: model.code, id: detail.entry.id }, detail, model }
}

/**
 * Порядок фото, отобранных кадров сета и файлов секстинга (DESIGN §4.5): «всё или
 * ничего», с версией объекта. «Сохранено · Отменить» возвращает прежний порядок.
 */
export function useReorderFiles() {
  const { api, params, detail } = useTarget()
  const toast = useActionToast()
  const { start } = useItemCommand<{ keys: string[]; previous: string[] | null }>({
    failed: 'Порядок не сохранился',
    run: ({ keys }, idempotencyKey) =>
      api.objectFiles.reorder({ params, body: { keys }, ifMatch: detail.version, idempotencyKey }),
    onSaved: (_saved, { previous }) =>
      toast.show({
        message: previous ? 'Сохранено' : 'Отменено',
        undoable: previous !== null,
        action: previous
          ? { label: 'Отменить', onSelect: () => start({ keys: previous, previous: null }) }
          : undefined,
      }),
  })
  return useCallback((keys: string[], previous: string[]) => start({ keys, previous }), [start])
}

/** Сет: `1` — отобрать, `3` — убрать из отобранных. */
export function usePickFrames() {
  const { api, params } = useTarget()
  const { start } = useItemCommand<{ keys: string[]; selected: boolean }>({
    failed: 'Отбор не сохранился',
    run: (body, idempotencyKey) => api.objectFiles.pick({ params, body, idempotencyKey }),
  })
  return useCallback((keys: string[], selected: boolean) => start({ keys, selected }), [start])
}

/** Лайф: «В ленту», «В чаты», «Оба». */
export function useAssignLife() {
  const { api, params } = useTarget()
  const toast = useActionToast()
  const selection = useFileSelection()
  const { start } = useItemCommand<{ keys: string[]; assignment: LifeAssignment | null }>({
    failed: 'Назначение не сохранилось',
    run: (body, idempotencyKey) => api.objectFiles.assign({ params, body, idempotencyKey }),
    onSaved: (_saved, { keys }) => {
      selection.clear()
      toast.show({ message: `Назначено · ${filesWord(keys.length)}` })
    },
  })
  return useCallback(
    (keys: string[], assignment: LifeAssignment | null) => start({ keys, assignment }),
    [start],
  )
}

/** «Убрать из объекта…»: мастер не убирается, сервер ответит 422. */
export function useRemoveFiles() {
  const { api, params, detail } = useTarget()
  const toast = useActionToast()
  const selection = useFileSelection()
  const { start } = useItemCommand<string[]>({
    failed: 'Не убралось',
    run: (keys, idempotencyKey) =>
      api.objectFiles.remove({ params, body: { keys }, ifMatch: detail.version, idempotencyKey }),
    onSaved: (_saved, keys) => {
      selection.clear()
      toast.show({ message: `Убрано из объекта · ${filesWord(keys.length)}` })
    },
  })
  return start
}

/** Скачать выбранные файлы: всегда со стёртыми метаданными по умолчанию. */
export function useDownloadFiles() {
  const { api, params } = useTarget()
  const deliver = useDeliverDownload()
  const { start } = useIntentMutation<{ keys: string[]; strip: boolean }, DownloadAnswer>({
    failed: 'Не скачалось',
    run: ({ keys, strip }, idempotencyKey) =>
      api.objectFiles.download({
        params,
        body: { keys, strip_metadata: strip },
        idempotencyKey,
      }),
    onSuccess: (answer) => deliver(params.model, [answer], { building: 'Файлы собираются' }),
  })
  return useCallback((keys: string[], strip = true) => start({ keys, strip }), [start])
}

/**
 * Долгая команда (202): операция встаёт в лоток и кольцом на плитки, к которым относится;
 * отдельной полоски не нужно — ход виден на месте.
 */
function useLongCommand<Variables>(
  label: string,
  run: (variables: Variables, idempotencyKey: string) => Promise<OperationAccepted>,
  keysOf: (variables: Variables) => readonly string[],
) {
  const { model, detail } = useObjectPage()
  const { trackOperation } = useUploads()
  const pending = usePendingOperations()
  const selection = useFileSelection()
  const { start } = useIntentMutation<Variables, OperationAccepted>({
    failed: 'Не запустилось',
    run,
    onSuccess: (accepted, variables) => {
      pending.add({ id: accepted.operation_id, keys: keysOf(variables), label })
      trackOperation(model.code, accepted.operation_id, `${label} · ${detail.entry.id}`)
      selection.clear()
    },
  })
  return start
}

/** «Сделать фото» из кадров мастера в полном размере. */
export function useMakePhotos() {
  const { api, params } = useTarget()
  return useLongCommand<{ frames: number[]; keys: string[] }>(
    'Фото из кадров собираются',
    ({ frames }, idempotencyKey) =>
      api.objectFiles.makePhotos({ params, body: { frames }, idempotencyKey }),
    ({ keys }) => keys,
  )
}

/** «Сделать обложкой»: кадр мастера или фото объекта. */
export function useMakeCover() {
  const { api, params } = useTarget()
  return useLongCommand<{ command: MakeCoverCommand; key: string }>(
    'Обложка собирается',
    ({ command }, idempotencyKey) =>
      api.objectFiles.makeCover({ params, body: command, idempotencyKey }),
    ({ key }) => [key],
  )
}

/** «Собрать версии» фупа: кольцо стоит на месте версий, пока они собираются. */
export function useBuildFypVersions() {
  const { api, params } = useTarget()
  return useLongCommand<BuildFypVersionsCommand>(
    'Версии фупа собираются',
    (body, idempotencyKey) => api.objectFiles.buildFypVersions({ params, body, idempotencyKey }),
    () => ['versions'],
  )
}

/** Назначение съёмки: «фупы / PPV / рассылка / неизвестно». */
export function useSetRawPurpose() {
  const { api, params, detail } = useTarget()
  const toast = useActionToast()
  const { start } = useItemCommand<RawPurpose>({
    failed: 'Назначение не сохранилось',
    run: (purpose, idempotencyKey) =>
      api.objectFiles.setPurpose({
        params,
        body: { purpose },
        ifMatch: detail.version,
        idempotencyKey,
      }),
    onSaved: () => toast.show({ message: 'Сохранено' }),
  })
  return start
}

/** «Выделить в новую съёмку»: выбранные файлы уходят в новый объект сырья. */
export function useExtractShoot() {
  const { api, params, model, detail } = useTarget()
  const toast = useActionToast()
  const navigate = useNavigate()
  const selection = useFileSelection()
  const { start } = useIntentMutation<string[], ItemCreated>({
    failed: 'Не выделилось',
    run: (keys, idempotencyKey) =>
      api.objectFiles.extractShoot({ params, body: { keys }, idempotencyKey }),
    invalidates: () => itemQueryKeys(model.code, detail.entry.id),
    onSuccess: ({ item_id: created }, keys) => {
      selection.clear()
      toast.show({
        message: `Выделено в ${created} · ${filesWord(keys.length)}`,
        action: {
          label: 'Открыть',
          onSelect: () =>
            void navigate({ to: '/$model/i/$id', params: { model: model.code, id: created } }),
        },
      })
    },
  })
  return useCallback(
    (keys: string[]) => {
      if (keys.length > 0) {
        start(keys)
      }
    },
    [start],
  )
}
