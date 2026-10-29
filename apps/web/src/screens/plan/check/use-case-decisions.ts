import {
  type ApiClient,
  type CaseResolution,
  type CheckCase,
  type ItemId,
  isApiError,
  type ModelCode,
  type PostSurface,
  SURFACE_LABEL,
  type UploadCheckResult,
} from '@contentops/contracts'
import { useCallback, useMemo, useState } from 'react'
import { useActionToast } from '@/actions/action-toast-context'
import { useIntentMutation } from '@/actions/use-intent-mutation'
import { useApi } from '@/data/api-session'
import { type CheckSync, type CheckView, useCheckSync } from '@/data/check'
import type { CaseAction } from './case-kinds'
import { caseLabel } from './case-text'

/**
 * Решения по случаю (DESIGN §4.15, §3.8): «Это оно», «Не то», «Привязать…», «Не наше» и
 * «Проверить заливку». Каждое — сразу, без «Вы уверены?», с полоской и «Отменить». Строка
 * сереет только после ответа заглушки, фокус уходит на следующий случай.
 */

export type Decision =
  | { action: 'confirm'; entry: CheckCase; evidenceId: string | null; surface?: PostSurface }
  | { action: 'reject'; entry: CheckCase; evidenceId: string | null }
  | { action: 'bind'; entry: CheckCase; itemId: ItemId }
  | { action: 'outside'; entry: CheckCase }

interface UndoRequest {
  caseId: string
  label: string
}

/** Что в пути у случая: решение, «Проверить заливку» или отмена из «Решённых». */
export type PendingAction = CaseAction | 'undo'

export interface PendingDecision {
  caseId: string
  action: PendingAction
}

interface DecisionOptions {
  /** Какой список на экране: его строки не перезапрашиваются; `null` — перечитать всё. */
  view: CheckView | null
  /** Случай решён — фокус на следующий (§7.8). */
  onSettled?: (caseId: string) => void
}

/** «Ни один» — «Не то» без варианта у случая с несколькими постами. */
function isRejectAll(decision: Decision): boolean {
  return (
    decision.action === 'reject' && decision.evidenceId === null && decision.entry.posts.length > 1
  )
}

function pendingAction(decision: Decision): CaseAction {
  return isRejectAll(decision) ? 'reject-all' : decision.action
}

function request(api: ApiClient, model: ModelCode, decision: Decision, idempotencyKey: string) {
  const params = { model, case: decision.entry.id }
  switch (decision.action) {
    case 'confirm':
      return api.check.confirmPair({
        params,
        body: { evidence_id: decision.evidenceId, surface: decision.surface },
        idempotencyKey,
      })
    case 'reject':
      return api.check.reject({
        params,
        body: { evidence_id: decision.evidenceId },
        idempotencyKey,
      })
    case 'bind':
      return api.check.bind({ params, body: { item_id: decision.itemId }, idempotencyKey })
    case 'outside':
      return api.check.outside({ params, idempotencyKey })
  }
}

/** Полоска после решения: «Подтверждено · FYP-0801 версия 1», «Не то · SET-072». */
function doneMessage(decision: Decision): string {
  const label = caseLabel(decision.entry)
  switch (decision.action) {
    case 'confirm':
      return `Подтверждено · ${label}${decision.surface ? ` · ${SURFACE_LABEL[decision.surface]}` : ''}`
    case 'reject':
      return `${isRejectAll(decision) ? 'Ни один' : 'Не то'} · ${label}`
    case 'bind':
      return `Привязано · ${label} → ${decision.itemId}`
    case 'outside':
      return `Не наше · ${label}`
  }
}

/**
 * Случай уже решил другой человек (422): список перечитывается, чтобы строка показала
 * настоящее состояние, а полоска — отказ словами сервера.
 */
async function reloadIfDecided<Result>(sync: CheckSync, run: () => Promise<Result>) {
  try {
    return await run()
  } catch (error) {
    if (isApiError(error) && error.status === 422) {
      sync.reload()
    }
    throw error
  }
}

export function useCaseDecisions(model: ModelCode, { view, onSettled }: DecisionOptions) {
  const api = useApi()
  const toast = useActionToast()
  const sync = useCheckSync(model)
  const [pending, setPending] = useState<PendingDecision | null>(null)
  const [uploadChecks, setUploadChecks] = useState<ReadonlyMap<string, UploadCheckResult>>(
    () => new Map(),
  )
  const [reopened, setReopened] = useState<ReadonlySet<string>>(() => new Set())

  const settle = useCallback(
    async (result: CaseResolution) => {
      await sync.apply(result.case_id, result.verdict)
      sync.refresh(view)
      if (result.verdict.sign !== 'turn') {
        onSettled?.(result.case_id)
      }
    },
    [onSettled, sync, view],
  )

  const undo = useIntentMutation<UndoRequest, CaseResolution>({
    failed: 'Не отменилось',
    run: ({ caseId }, key) =>
      reloadIfDecided(sync, () =>
        api.check.undo({ params: { model, case: caseId }, idempotencyKey: key }),
      ),
    onSuccess: (result, { caseId, label }) => {
      void settle(result)
      setReopened((current) => new Set(current).add(caseId))
      toast.show({ message: `Отменено · ${label} снова в разборе` })
    },
  })

  const decide = useIntentMutation<Decision, CaseResolution>({
    failed: 'Не записалось',
    run: (decision, key) => reloadIfDecided(sync, () => request(api, model, decision, key)),
    onSuccess: (result, decision) => {
      void settle(result)
      const target = { caseId: decision.entry.id, label: caseLabel(decision.entry) }
      toast.show({
        message: doneMessage(decision),
        action: { label: 'Отменить', onSelect: () => undo.start(target) },
        undoable: true,
      })
    },
  })

  const checkUpload = useIntentMutation<string, UploadCheckResult>({
    failed: 'Не отправилось',
    run: (caseId, key) =>
      api.check.checkUpload({ params: { model, case: caseId }, idempotencyKey: key }),
    onSuccess: (result, caseId) => {
      setUploadChecks((current) => new Map(current).set(caseId, result))
      toast.show({ message: result.text })
    },
  })

  const busy = decide.isPending || checkUpload.isPending || undo.isPending

  return useMemo(
    () => ({
      /** Что сейчас в пути; после ответа или отказа — `null`. */
      pending: busy ? pending : null,
      /** Ответы на «Проверить заливку» по случаю: «В очереди · проверим за сутки». */
      uploadChecks,
      /** Случаи, которые вернули в разбор из «Решённых» и «Не наше»: строка там сереет. */
      reopened,
      decide: (decision: Decision) => {
        setPending({ caseId: decision.entry.id, action: pendingAction(decision) })
        decide.start(decision)
      },
      checkUpload: (caseId: string) => {
        setPending({ caseId, action: 'check-upload' })
        checkUpload.start(caseId)
      },
      undo: (caseId: string, label: string) => {
        setPending({ caseId, action: 'undo' })
        undo.start({ caseId, label })
      },
    }),
    [busy, checkUpload.start, decide.start, pending, reopened, undo.start, uploadChecks],
  )
}

export type CaseDecisions = ReturnType<typeof useCaseDecisions>
