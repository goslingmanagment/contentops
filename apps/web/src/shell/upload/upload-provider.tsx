import {
  type ItemId,
  ItemIdSchema,
  type ModelCode,
  newIdempotencyKey,
  tusUploadsPath,
  type UploadedFile,
  type UploadKind,
  type UploadResult,
  uploadKindNeedsTarget,
} from '@contentops/contracts'
import { UploadTray } from '@contentops/ui/components/upload-tray'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { Upload as TusUpload } from 'tus-js-client'
import { describeFailure } from '@/actions/failure-message'
import { useApi, useMockApi, useSaveFile } from '@/data/api-session'
import type { CatalogIndexView } from '@/data/catalog'
import { inboxChangedKeys } from '@/data/inbox'
import { itemQueryKeys } from '@/data/object'
import { planChangedKeys } from '@/data/plan'
import { queryKeys } from '@/data/query-keys'
import { DropHint } from './drop-hint'
import { OperationWatcher } from './operation-watcher'
import { trayItems, trayTitle } from './tray-labels'
import { type OpenUploadOptions, type UploadsApi, UploadsContext } from './upload-context'
import { UploadDialog } from './upload-dialog'
import type { UploadForm } from './upload-form'
import {
  batchesReadyToSend,
  commandFiles,
  hasActiveWork,
  initialUploadState,
  isUploadActive,
  nextToTransfer,
  type OperationUpdate,
  type UploadAction,
  type UploadBatch,
  type UploadEntry,
  type UploadOutcome,
  type UploadState,
  uploadReducer,
} from './upload-store'
import { mediaOf, sameTarget, targetRef, type UploadTarget } from './upload-target'
import { useFileDrag } from './use-file-drag'

const TICK_MS = 200
/** Кусок tus: столько байт уходит одним запросом и теряется самое большее при обрыве. */
const CHUNK_BYTES = 50 * 1024 * 1024
/** Повторы куска до «Загрузка прервана · Продолжить». */
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 5_000, 10_000]

interface DialogState {
  files: readonly File[]
  target: UploadTarget | null
  kind: UploadKind | null
}

/**
 * Загрузка для всей оболочки (DESIGN §3.7): окно «Загрузить», файлы, отпущенные на окно,
 * и лоток внизу справа, который остаётся при переходе между экранами. При закрытии
 * вкладки во время загрузки браузер спрашивает, уйти ли.
 */
export function UploadProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, dispatch] = useReducer(uploadReducer, initialUploadState)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [screenTarget, setScreenTargetState] = useState<UploadTarget | null>(null)
  const routeTarget = useRouteTarget()
  const model = useParams({ strict: false }).model
  const mockApi = useMockApi()
  /** Файлы пачек, пока их байты не на сервере; передачи tus по записи лотка. */
  const files = useRef(new Map<string, File>())
  const transfers = useRef(new Map<string, TusUpload>())

  const setScreenTarget = useCallback((next: UploadTarget | null) => {
    setScreenTargetState((previous) => (sameTarget(previous, next) ? previous : next))
  }, [])

  const openUploadDialog = useCallback(
    (files: readonly File[] = [], options: OpenUploadOptions = {}) =>
      setDialog({
        files,
        target: options.target ?? screenTarget ?? routeTarget(),
        kind: options.kind ?? null,
      }),
    [routeTarget, screenTarget],
  )

  const trackOperation = useCallback(
    (model: string, operationId: string, label: string) =>
      dispatch({
        type: 'track-operation',
        operation: { id: operationId, model, label, progress: 0, state: 'running' },
      }),
    [],
  )

  const api = useMemo<UploadsApi>(
    () => ({ openUploadDialog, trackOperation, setScreenTarget }),
    [openUploadDialog, setScreenTarget, trackOperation],
  )

  const uploading = state.uploads.some(isUploadActive)
  useUploadClock(uploading, dispatch)
  useTusTransfers(state, dispatch, files.current, transfers.current)
  useSendBatches(state, dispatch, files.current)
  useLeaveWarning(uploading)
  const dialogOpen = dialog !== null
  const dragging = useFileDrag((files) => {
    if (enabled && !dialogOpen) {
      openUploadDialog(files)
    }
  })

  const submit = (form: UploadForm) => {
    if (!model) {
      return
    }
    const target = uploadKindNeedsTarget(form.kind) ? (dialog?.target ?? null) : null
    const entries = form.files.map((file) => {
      const id = newIdempotencyKey()
      files.current.set(id, file)
      return { id, fileName: file.name, sizeBytes: file.size, media: mediaOf(file) }
    })
    dispatch({
      type: 'add-batch',
      batch: { id: newIdempotencyKey(), model, kind: form.kind, target },
      files: entries,
      // Строка плана в разработке живёт в заглушке: туда и команда, байты не нужны.
      transport: mockApi && target?.kind === 'plan-row' ? 'simulated' : 'tus',
    })
    setDialog(null)
  }

  const cancelAll = () => {
    // Незаконченные загрузки tus снимаются и на сервере (`abandoned`).
    for (const [id, transfer] of transfers.current) {
      void transfer.abort(true).catch(() => {})
      transfers.current.delete(id)
    }
    for (const entry of state.uploads) {
      if (isUploadActive(entry)) {
        files.current.delete(entry.id)
      }
    }
    dispatch({ type: 'cancel-uploads' })
  }

  const onOperationChange = useCallback(
    (update: OperationUpdate) => dispatch({ type: 'update-operation', ...update }),
    [],
  )
  const saveFile = useSaveFile()

  const showTray = state.uploads.length > 0 || state.operations.length > 0
  return (
    <UploadsContext value={api}>
      {children}
      <UploadDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
          }
        }}
        target={dialog?.target ?? null}
        initialKind={dialog?.kind ?? null}
        initialFiles={dialog?.files ?? []}
        onSubmit={submit}
      />
      {state.operations
        .filter((entry) => entry.state === 'running')
        .map((entry) => (
          <OperationWatcher key={entry.id} entry={entry} onChange={onOperationChange} />
        ))}
      {showTray ? (
        <UploadTray
          title={trayTitle(state)}
          items={trayItems(state, saveFile)}
          collapsed={state.collapsed}
          onCollapsedChange={(collapsed) => dispatch({ type: 'set-collapsed', collapsed })}
          onCancelAll={uploading ? cancelAll : undefined}
          onResume={(id) => dispatch({ type: 'resume', id })}
          onClose={hasActiveWork(state) ? undefined : () => dispatch({ type: 'clear-finished' })}
          avoid="main aside"
        />
      ) : null}
      {dragging && enabled && dialog === null ? (
        <DropHint target={screenTarget ?? routeTarget()} />
      ) : null}
    </UploadsContext>
  )
}

/** Объект из адреса `/<модель>/i/<ID>` — цель по умолчанию, с названием из индекса. */
function useRouteTarget(): () => UploadTarget | null {
  const queryClient = useQueryClient()
  const params = useParams({ strict: false })
  const model = params.model
  const id = ItemIdSchema.safeParse(params.id).data
  return useCallback(() => {
    if (!model || !id) {
      return null
    }
    const index = queryClient.getQueryData<CatalogIndexView>(queryKeys.catalogIndex(model))
    return { kind: 'item', itemId: id, title: titleOf(index, id) }
  }, [id, model, queryClient])
}

function titleOf(index: CatalogIndexView | undefined, id: ItemId): string {
  return index?.byId.get(id)?.title ?? id
}

/**
 * Байты по tus (SPEC §6.1), по одному файлу: куски по 50 МБ, после сбоя — повторы, затем
 * «Загрузка прервана · Продолжить». Тот же файл, выбранный снова (и после перезагрузки
 * страницы), продолжает с принятого байта: адрес загрузки tus помнит по отпечатку файла.
 */
function useTusTransfers(
  state: UploadState,
  dispatch: (action: UploadAction) => void,
  files: Map<string, File>,
  transfers: Map<string, TusUpload>,
) {
  const next = nextToTransfer(state)
  const batch = next ? state.batches.find((candidate) => candidate.id === next.batchId) : undefined
  const nextId = next?.id
  useEffect(() => {
    if (!nextId || !batch || transfers.has(nextId)) {
      return
    }
    const file = files.get(nextId)
    if (!file) {
      dispatch({ type: 'interrupted', id: nextId })
      return
    }
    dispatch({ type: 'progress', id: nextId, loadedBytes: 0 })
    const transfer: TusUpload = new TusUpload(file, {
      endpoint: tusUploadsPath(batch.model),
      chunkSize: CHUNK_BYTES,
      retryDelays: RETRY_DELAYS_MS,
      metadata: { filename: file.name, filetype: file.type, kind: batch.kind },
      removeFingerprintOnSuccess: true,
      onProgress: (sent) => dispatch({ type: 'progress', id: nextId, loadedBytes: sent }),
      onSuccess: () => {
        transfers.delete(nextId)
        dispatch({
          type: 'transferred',
          id: nextId,
          uploadId: transfer.url?.split('/').pop() ?? '',
          now: performance.now(),
        })
      },
      onError: () => {
        transfers.delete(nextId)
        dispatch({ type: 'interrupted', id: nextId })
      },
    })
    transfers.set(nextId, transfer)
    void transfer.findPreviousUploads().then(
      (previous) => {
        const [last] = previous
        if (last) {
          transfer.resumeFromPreviousUpload(last)
        }
        transfer.start()
      },
      () => transfer.start(),
    )
  }, [batch, dispatch, files, nextId, transfers])
}

/**
 * Пачка, все файлы которой переданы, уходит на сервер одной командой с ключом повтора
 * пачки. Ответ решает, что сказать в лотке, и сбрасывает то, что поменялось: «Приехало»
 * и счётчик колонки, объект цели и план.
 */
function useSendBatches(
  state: UploadState,
  dispatch: (action: UploadAction) => void,
  files: Map<string, File>,
) {
  const api = useApi()
  const mockApi = useMockApi()
  const queryClient = useQueryClient()
  const sent = useRef(new Set<string>())
  const ready = batchesReadyToSend(state).map((batch) => ({
    batch,
    files: commandFiles(state, batch),
    entries: state.uploads.filter((entry) => entry.batchId === batch.id),
  }))
  useEffect(() => {
    for (const { batch, files: body, entries } of ready) {
      if (sent.current.has(batch.id)) {
        continue
      }
      sent.current.add(batch.id)
      dispatch({ type: 'batch-sent', id: batch.id })
      const settle = (outcome: UploadOutcome) =>
        dispatch({ type: 'batch-settled', id: batch.id, outcome })
      send(batch.transport === 'simulated' && mockApi ? mockApi : api, batch, body)
        .then(
          (result) => {
            for (const queryKey of changedKeys(batch.model, batch, result)) {
              void queryClient.invalidateQueries({ queryKey })
            }
            settle(outcomeOf(result))
          },
          (error: unknown) => settle({ kind: 'failed', message: failureReason(error) }),
        )
        .finally(() => forget(files, entries))
    }
  }, [api, dispatch, files, mockApi, queryClient, ready])
}

function send(client: ReturnType<typeof useApi>, batch: UploadBatch, files: UploadedFile[]) {
  return client.inbox.upload({
    params: { model: batch.model },
    body: {
      kind: batch.kind,
      target: batch.target ? targetRef(batch.target) : null,
      files,
    },
    idempotencyKey: batch.id,
  })
}

function forget(files: Map<string, File>, entries: readonly UploadEntry[]) {
  for (const entry of entries) {
    files.delete(entry.id)
  }
}

/** «тизер — один видеофайл», «нет связи»: причина без «Не выполнено» (§3.8). */
function failureReason(error: unknown): string {
  const message = describeFailure(error, 'Не принято')?.message ?? 'отменено'
  return message.replace(/^(Не выполнено|Не принято): /, '')
}

function outcomeOf(result: UploadResult): UploadOutcome {
  if (result.placed === 'attached' && result.item_id) {
    return { kind: 'attached', itemId: result.item_id }
  }
  return { kind: 'inbox', decision: result.decision !== null }
}

function changedKeys(model: ModelCode, batch: UploadBatch, result: UploadResult) {
  return [
    ...inboxChangedKeys(model),
    ...(result.item_id ? itemQueryKeys(model, result.item_id) : []),
    ...(batch.target?.kind === 'plan-row' ? planChangedKeys(model) : []),
  ]
}

/** Часы лотка: изображаемая передача в заглушку и конец проверки после ответа. */
function useUploadClock(
  active: boolean,
  dispatch: (action: { type: 'tick'; elapsedMs: number; now: number }) => void,
) {
  const last = useRef(0)
  useEffect(() => {
    if (!active) {
      return
    }
    last.current = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      dispatch({ type: 'tick', elapsedMs: now - last.current, now })
      last.current = now
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [active, dispatch])
}

/** Закрыть вкладку посреди загрузки можно, но браузер переспросит. */
function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) {
      return
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])
}
