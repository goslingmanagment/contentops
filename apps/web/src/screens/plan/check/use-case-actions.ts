import type { Account, CheckCase } from '@contentops/contracts'
import type { ItemMenuModel } from '@contentops/ui/components/item-menu'
import { useCallback, useMemo } from 'react'
import type { CaseAction } from './case-kinds'
import { caseMenu } from './case-menu'
import type { CaseDecisions } from './use-case-decisions'

interface CaseActionsOptions {
  accounts: readonly Account[]
  canDecide: boolean
  decisions: CaseDecisions
  /** Открыть случай в панели; `withSearch` — сразу поиск по каталогу («Привязать…»). */
  select: (caseId: string, withSearch?: boolean) => void
}

/**
 * Что делает каждая кнопка случая (DESIGN §4.15): одна таблица для строки, клавиш `1`
 * `2` `3`, меню «⋯» и правого клика — без развилок по экрану.
 */
export function useCaseActions({ accounts, canDecide, decisions, select }: CaseActionsOptions) {
  const act = useMemo((): Record<CaseAction, (entry: CheckCase) => void> => {
    const evidenceOf = (entry: CheckCase) => entry.posts[0]?.evidence_id ?? null
    return {
      confirm: (entry) =>
        decisions.decide({ action: 'confirm', entry, evidenceId: evidenceOf(entry) }),
      reject: (entry) =>
        decisions.decide({ action: 'reject', entry, evidenceId: evidenceOf(entry) }),
      'reject-all': (entry) => decisions.decide({ action: 'reject', entry, evidenceId: null }),
      review: (entry) => select(entry.id),
      bind: (entry) => select(entry.id, true),
      outside: (entry) => decisions.decide({ action: 'outside', entry }),
    }
  }, [decisions, select])

  const accountOf = useCallback(
    (entry: CheckCase) => accounts.find((account) => account.code === entry.account),
    [accounts],
  )

  const menuFor = useCallback(
    (entry: CheckCase): ItemMenuModel =>
      caseMenu(entry, accountOf(entry), canDecide, {
        onReview: () => act.review(entry),
        onOutside: () => act.outside(entry),
      }),
    [accountOf, act, canDecide],
  )

  return { act, accountOf, menuFor }
}
