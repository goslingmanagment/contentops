import {
  type CaseBatchResult,
  type CaseResolution,
  type CheckCase,
  formatNumber,
  type ModelCode,
} from '@contentops/contracts'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { useCheckSync } from '@/data/check'

interface BulkOptions {
  /** «Показать» в полоске: выделить пару, которую уже изменили. */
  onShow: (caseId: string) => void
  /** Её уже решил другой и в очереди её нет: «Показать» открывает «Решённые». */
  onShowDone: () => void
}

/** Итог пакета «по каждой записи» (DESIGN §3.3): «Подтверждено 1 из 2 · 1 уже изменили». */
function batchMessage(done: number, total: number): string {
  if (done === total) {
    return `Подтверждено ${formatNumber(done)}`
  }
  return `Подтверждено ${formatNumber(done)} из ${formatNumber(total)} · ${formatNumber(total - done)} уже изменили`
}

/**
 * «Подтвердить однозначные · 2» (DESIGN §4.15): пары, которые человек видел во всплывашке,
 * подтверждаются по каждой записи. Строки сереют на месте по ответу; «Отменить» снимает
 * все подтверждения пакета.
 */
export function useBulkConfirm(model: ModelCode, { onShow, onShowDone }: BulkOptions) {
  const api = useApi()
  const toast = useActionToast()
  const sync = useCheckSync(model)

  const undoAll = useIntentMutation<readonly string[], CaseResolution[]>({
    failed: 'Не отменилось',
    run: (ids, key) =>
      Promise.all(
        ids.map((id) =>
          api.check.undo({ params: { model, case: id }, idempotencyKey: `${key}:${id}` }),
        ),
      ),
    onSuccess: (results) => {
      for (const result of results) {
        void sync.apply(result.case_id, result.verdict)
      }
      sync.refresh('open')
      toast.show({ message: `Отменено · ${formatNumber(results.length)} снова в разборе` })
    },
  })

  const confirm = useIntentMutation<readonly CheckCase[], CaseBatchResult>({
    failed: 'Не подтвердилось',
    run: (cases, key) =>
      api.check.confirmUnambiguous({
        params: { model },
        body: { case_ids: cases.map((entry) => entry.id) },
        idempotencyKey: key,
      }),
    onSuccess: ({ results }) => {
      const done: string[] = []
      for (const result of results) {
        if (result.ok && result.verdict) {
          done.push(result.id)
          void sync.apply(result.id, result.verdict)
        }
      }
      sync.refresh('open')
      const refused = results.find((result) => !result.ok)
      if (refused) {
        // Непрошедшую пару изменили без нас: список показывает её настоящее состояние.
        sync.reload()
      }
      const show = (caseId: string) => (sync.isListed(caseId) ? onShow(caseId) : onShowDone())
      toast.show({
        message: batchMessage(done.length, results.length),
        action: refused
          ? { label: 'Показать', onSelect: () => show(refused.id) }
          : { label: 'Отменить', onSelect: () => undoAll.start(done) },
        undoable: !refused,
      })
    },
  })

  return { start: confirm.start, isPending: confirm.isPending }
}
