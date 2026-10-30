import {
  type ItemId,
  ItemIdSchema,
  type ModelCode,
  newIdempotencyKey,
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
import { describeFailure } from '@/actions/failure-message'
import { useApi, useSaveFile } from '@/data/api-session'
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
  hasActiveWork,
  initialUploadState,
  isUploadActive,
  type OperationUpdate,
  type UploadAction,
  type UploadBatch,
  type UploadOutcome,
  uploadReducer,
} from './upload-store'
import { mediaOf, sameTarget, targetRef, type UploadTarget } from './upload-target'
import { useFileDrag } from './use-file-drag'

const TICK_MS = 200

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
  useSendBatches(batchesReadyToSend(state), dispatch)
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
    dispatch({
      type: 'add-batch',
      batch: { id: newIdempotencyKey(), model, kind: form.kind, target },
      files: form.files.map((file) => ({
        id: newIdempotencyKey(),
        fileName: file.name,
        sizeBytes: file.size,
        media: mediaOf(file),
      })),
    })
    setDialog(null)
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
          onCancelAll={uploading ? () => dispatch({ type: 'cancel-uploads' }) : undefined}
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
 * Пачка, все файлы которой переданы, уходит на сервер одной командой с ключом повтора
 * пачки. Ответ решает, что сказать в лотке, и сбрасывает то, что поменялось: «Приехало»
 * и счётчик колонки, объект цели и план.
 */
function useSendBatches(ready: readonly UploadBatch[], dispatch: (action: UploadAction) => void) {
  const api = useApi()
  const queryClient = useQueryClient()
  const sent = useRef(new Set<string>())
  useEffect(() => {
    for (const batch of ready) {
      if (sent.current.has(batch.id)) {
        continue
      }
      sent.current.add(batch.id)
      dispatch({ type: 'batch-sent', id: batch.id })
      const settle = (outcome: UploadOutcome) =>
        dispatch({ type: 'batch-settled', id: batch.id, outcome })
      api.inbox
        .upload({
          params: { model: batch.model },
          body: {
            kind: batch.kind,
            target: batch.target ? targetRef(batch.target) : null,
            files: [...batch.files],
          },
          idempotencyKey: batch.id,
        })
        .then(
          (result) => {
            for (const queryKey of changedKeys(batch.model, batch, result)) {
              void queryClient.invalidateQueries({ queryKey })
            }
            settle(outcomeOf(result))
          },
          (error: unknown) => settle({ kind: 'failed', message: failureReason(error) }),
        )
    }
  }, [api, dispatch, queryClient, ready])
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

/** Ход имитации загрузки: прототип не шлёт файлы на сервер. */
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
