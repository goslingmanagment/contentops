import type {
  AcceptCommand,
  AcceptManyResult,
  AcceptResult,
  BatchResult,
  DecideCommand,
  DownloadAnswer,
  InboxGroup,
  ItemType,
  UpdateDraftFilesCommand,
  VideoInSetDestination,
} from '@contentops/contracts'
import { useNavigate } from '@tanstack/react-router'
import { useActionToast } from '@/actions/action-toast-context'
import { failedIds } from '@/actions/batch-result'
import { useDeliverDownload } from '@/actions/use-deliver-download'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import {
  inboxChangedKeys,
  touchedByAccept,
  useDropInboxGroups,
  useInboxCommands,
  usePutInboxGroup,
} from '@/data/inbox'
import { usePlanDialog } from '@/shell/dialogs/plan-dialog-context'
import { useCurrentModel } from '@/shell/model/model-context'
import { useUploads } from '@/shell/upload/upload-context'
import {
  acceptedMessage,
  acceptManyMessage,
  batchMessage,
  groupsWord,
  type NextStep,
  nextStepOf,
} from './accept-texts'
import { TYPE_WORD } from './group-texts'
import { videoDoneMessage } from './video-destinations'

interface AcceptVariables {
  group: InboxGroup
  command: AcceptCommand
}

/**
 * Что стало с группой после решения — куда деть фокус (§7.8): `stay` — группа на месте
 * и ждёт следующего шага («Этот заказ» → «Принять как сдачу»), `gone` — ушла из списка,
 * `skip` — человеку делать с ней нечего («Повторить», «Ждать»).
 */
export type DecisionOutcome = 'stay' | 'gone' | 'skip'

interface ActionsOptions {
  /** «Показать» в итоге пакета выделяет непрошедшие группы. */
  onShow?: (ids: readonly string[]) => void
  /** После решения: фокус в список, при `skip` — на следующую группу, где нужен человек. */
  onDecided?: (group: InboxGroup, outcome: DecisionOutcome) => void
}

/**
 * Действия «Приехало» (DESIGN §4.8, §3.8): каждое нажатие — своё намерение с ключом
 * повтора, «сохранено» — только после ответа. Решённые группы уходят из списка сразу,
 * фокус идёт на следующую.
 */
export function useIntakeActions({ onShow, onDecided }: ActionsOptions = {}) {
  const model = useCurrentModel().code
  const commands = useInboxCommands(model)
  const putGroup = usePutInboxGroup(model)
  const dropGroups = useDropInboxGroups(model)
  const toast = useActionToast()
  const navigate = useNavigate()
  const { openPlanDialog } = usePlanDialog()
  const { openUploadDialog } = useUploads()
  const deliver = useDeliverDownload()
  const changed = () => inboxChangedKeys(model)

  const openItem = (id: string) => void navigate({ to: '/$model/i/$id', params: { model, id } })

  const closeOrder = useIntentMutation<string, unknown>({
    failed: 'Заказ не закрылся',
    run: (order, key) => commands.closeOrder(order, key),
    invalidates: (order) => inboxChangedKeys(model, { orders: [order] }),
    onSuccess: () => toast.show({ message: 'Заказ закрыт' }),
  })

  const nextStepAction = (step: NextStep, result: AcceptResult, group: InboxGroup) => {
    const handlers: Record<NextStep, () => void> = {
      open: () => openItem(result.item_id),
      upload_teaser: () => {
        openItem(result.item_id)
        openUploadDialog()
      },
      plan: () => openPlanDialog([result.item_id]),
      close_order: () => {
        if (group.fields.order_id) {
          closeOrder.start(group.fields.order_id)
        }
      },
    }
    return handlers[step]
  }

  const accept = useIntentMutation<AcceptVariables, AcceptResult>({
    failed: 'Не принялось',
    run: ({ group, command }, key) => commands.accept(group.id, command, key),
    invalidates: ({ group, command }) => inboxChangedKeys(model, touchedByAccept(group, command)),
    onSuccess: (result, { group }) => {
      dropGroups([group.id])
      onDecided?.(group, 'gone')
      const open = { label: 'Открыть', onSelect: () => openItem(result.item_id) }
      toast.show(
        result.next_step
          ? {
              message: acceptedMessage(result),
              secondaryAction: open,
              action: {
                label: result.next_step,
                onSelect: nextStepAction(nextStepOf(result.next_step), result, group),
              },
            }
          : { message: acceptedMessage(result), action: open },
      )
    },
  })

  const showBatch = (verb: string, result: BatchResult) => {
    const failed = failedIds(result)
    toast.show({
      message: batchMessage(verb, result),
      action:
        failed.length > 0 && onShow
          ? { label: 'Показать', onSelect: () => onShow(failed) }
          : undefined,
    })
  }

  const acceptMany = useIntentMutation<readonly InboxGroup[], AcceptManyResult>({
    failed: 'Не принялось',
    run: (groups, key) =>
      commands.acceptMany(
        groups.map((group) => group.id),
        key,
      ),
    invalidates: (groups) => {
      const touched = groups.map((group) => touchedByAccept(group))
      return inboxChangedKeys(model, {
        items: touched.flatMap((entry) => entry.items ?? []),
        orders: touched.flatMap((entry) => entry.orders ?? []),
      })
    },
    onSuccess: (result, groups) => {
      dropGroups(result.results.filter((entry) => entry.ok).map((entry) => entry.id))
      const [first] = groups
      if (first) {
        onDecided?.(first, 'gone')
      }
      const failed = failedIds(result)
      const accepted = result.results.flatMap((entry) => (entry.accepted ? [entry.accepted] : []))
      const [only] = accepted
      toast.show({
        message: acceptManyMessage(result),
        action:
          failed.length > 0 && onShow
            ? { label: 'Показать', onSelect: () => onShow(failed) }
            : accepted.length === 1 && only
              ? { label: 'Открыть', onSelect: () => openItem(only.item_id) }
              : undefined,
      })
    },
  })

  const decide = useIntentMutation<{ group: InboxGroup; command: DecideCommand }, InboxGroup>({
    failed: 'Не сохранилось',
    run: ({ group, command }, key) => commands.decide(group.id, command, key),
    // Монтаж, подставленный в строку, меняет план и сам объект монтажа.
    invalidates: ({ group, command }) =>
      command.decision === 'substitute_montage'
        ? inboxChangedKeys(model, {
            plan: true,
            items: group.target_item ? [group.target_item] : [],
          })
        : changed(),
    onSuccess: (group, { command }) => {
      // Архив, разделённый по папкам, уходит: его папки приходят своими группами.
      if (command.decision === 'split_archive' && command.split) {
        dropGroups([group.id])
        onDecided?.(group, 'gone')
        toast.show({ message: 'Архив разделён по папкам' })
        return
      }
      putGroup(group)
      onDecided?.(group, group.state.kind === 'accepted' ? 'gone' : 'stay')
      if (command.decision === 'video_in_set') {
        toast.show({ message: videoDoneMessage(command.destination, 1) })
      }
    },
  })

  const setType = useIntentMutation<{ ids: readonly string[]; type: ItemType }, BatchResult>({
    failed: 'Тип не сменился',
    run: ({ ids, type }, key) => commands.setType(ids, type, key),
    invalidates: changed,
    onSuccess: (result, { type }) => showBatch(`Тип «${TYPE_WORD[type]}»:`, result),
  })

  const videoDestination = useIntentMutation<
    { ids: readonly string[]; destination: VideoInSetDestination },
    InboxGroup[]
  >({
    failed: 'Не сохранилось',
    run: ({ ids, destination }, key) => commands.videoDestination(ids, destination, key),
    invalidates: changed,
    onSuccess: (groups, { destination }) => {
      for (const group of groups) {
        putGroup(group)
      }
      toast.show({ message: videoDoneMessage(destination, groups.length) })
    },
  })

  const merge = useIntentMutation<readonly string[], InboxGroup>({
    failed: 'Не слилось',
    run: (ids, key) => commands.merge(ids, key),
    invalidates: changed,
    onSuccess: (group, ids) => {
      dropGroups(ids.filter((id) => id !== group.id))
      putGroup(group)
      onShow?.([group.id])
      toast.show({ message: `Слито ${groupsWord(ids.length)} в «${group.title}»` })
    },
  })

  const split = useIntentMutation<{ group: InboxGroup; keys: readonly string[] }, InboxGroup>({
    failed: 'Не выделилось',
    run: ({ group, keys }, key) => commands.split(group.id, keys, key),
    invalidates: changed,
    onSuccess: (part) =>
      toast.show({
        message: `Выделено в новую группу · ${part.file_count}`,
        action: onShow ? { label: 'Показать', onSelect: () => onShow([part.id]) } : undefined,
      }),
  })

  const restore = useIntentMutation<string, InboxGroup>({
    failed: 'Не вернулось',
    run: (id, key) => commands.restore(id, key),
    invalidates: changed,
    onSuccess: () => toast.show({ message: 'Возвращено в работу' }),
  })

  const reject = useIntentMutation<{ ids: readonly string[]; reason: string | null }, InboxGroup[]>(
    {
      failed: 'Не отклонилось',
      run: ({ ids, reason }, key) =>
        Promise.all(ids.map((id) => commands.reject(id, reason, `${key}:${id}`))),
      invalidates: changed,
      onSuccess: (groups) => {
        dropGroups(groups.map((group) => group.id))
        const [single] = groups
        if (single) {
          onDecided?.(single, 'gone')
        }
        toast.show({
          message: groups.length === 1 ? 'Отклонено' : `Отклонено: ${groupsWord(groups.length)}`,
          action:
            groups.length === 1 && single
              ? { label: 'Вернуть', onSelect: () => restore.start(single.id) }
              : undefined,
        })
      },
    },
  )

  const retry = useIntentMutation<string, InboxGroup>({
    failed: 'Не повторилось',
    run: (id, key) => commands.retry(id, key),
    invalidates: changed,
    onSuccess: (group) => {
      putGroup(group)
      onDecided?.(group, 'skip')
    },
  })

  const files = useIntentMutation<
    { group: InboxGroup; change: UpdateDraftFilesCommand; undo: UpdateDraftFilesCommand | null },
    InboxGroup
  >({
    failed: 'Не сохранилось',
    run: ({ group, change }, key) => commands.files(group, change, key),
    onSuccess: (group, { undo }) => {
      putGroup(group)
      toast.show({
        message: 'Сохранено',
        undoable: undo !== null,
        action: undo
          ? { label: 'Отменить', onSelect: () => files.start({ group, change: undo, undo: null }) }
          : undefined,
      })
    },
  })

  const download = useIntentMutation<InboxGroup, DownloadAnswer>({
    failed: 'Не скачалось',
    run: (group, key) => commands.download(group.id, key),
    onSuccess: (answer) => deliver(model, [answer], { building: 'Исходники собираются' }),
  })

  return {
    accept: (group: InboxGroup, command: AcceptCommand) => accept.start({ group, command }),
    accepting: accept.isPending,
    acceptMany: (groups: readonly InboxGroup[]) => acceptMany.start(groups),
    acceptingMany: acceptMany.isPending,
    decide: (group: InboxGroup, command: DecideCommand) => decide.start({ group, command }),
    deciding: decide.isPending,
    setType: (ids: readonly string[], type: ItemType) => setType.start({ ids, type }),
    videoDestination: (ids: readonly string[], destination: VideoInSetDestination) =>
      videoDestination.start({ ids, destination }),
    merge: (ids: readonly string[]) => merge.start(ids),
    split: (group: InboxGroup, keys: readonly string[]) => split.start({ group, keys }),
    reject: (ids: readonly string[], reason: string | null) => reject.start({ ids, reason }),
    rejecting: reject.isPending,
    retry: (id: string) => retry.start(id),
    retrying: retry.isPending,
    restore: (id: string) => restore.start(id),
    restoring: restore.isPending,
    files: (
      group: InboxGroup,
      change: UpdateDraftFilesCommand,
      undo: UpdateDraftFilesCommand | null,
    ) => files.start({ group, change, undo }),
    download: (group: InboxGroup) => download.start(group),
    downloading: download.isPending,
  }
}

export type IntakeActions = ReturnType<typeof useIntakeActions>
