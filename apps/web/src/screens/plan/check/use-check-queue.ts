import type { AccountCode, CheckCase, Model } from '@contentops/contracts'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'
import { useClock } from '@/data/api-session'
import { isOpenCase, useCheckQueueList, useUnverifiedRows } from '@/data/check'
import { useIntegrations } from '@/data/integrations'
import { useHistoryState } from '@/lib/use-history-state'
import { type CaseFilter, filterCases, groupByPage, weekOptions } from './case-groups'
import { hubCanCheck, hubUpdatedAt, placeHubLines } from './hub-lines'
import { buildQueue } from './queue-items'

const UnverifiedStateSchema = z.object({
  open: z.boolean(),
  reasons: z.array(z.string()),
})

const CLOSED: z.output<typeof UnverifiedStateSchema> = { open: false, reasons: [] }

/**
 * Очередь «Сверить» из ответа сервера (DESIGN §4.15): случаи по страницам с чипами, строки
 * Hub по месту, серая строка «Hub не смог проверить» и что из неё раскрыто. Раскрытое
 * живёт в записи истории: «Назад» возвращает его вместе с прокруткой.
 */
export function useCheckQueue(model: Model, { page, week }: CaseFilter) {
  const now = useClock().now()
  const list = useCheckQueueList(model.code)
  const integrations = useIntegrations().data
  const [unverifiedState, setUnverifiedState] = useHistoryState(
    'check:unverified',
    UnverifiedStateSchema,
    () => CLOSED,
  )
  const wantRows = unverifiedState.open && unverifiedState.reasons.length > 0
  const rows = useUnverifiedRows(model.code, wantRows).data

  const derived = useMemo(() => {
    const cases: readonly CheckCase[] = list.data?.items ?? []
    const visible = filterCases(cases, { page, week })
    const groups = groupByPage(visible, model.accounts)
    const shown = new Set(groups.map((group) => group.account.code))
    const hubLines = placeHubLines(integrations, model, shown, now)
    const queue = buildQueue({
      groups,
      hubLines,
      unverified: list.data?.unverified ?? null,
      state: unverifiedState,
      rows,
      filtered: cases.length > 0 && visible.length === 0,
    })
    const unambiguousIds = new Set(list.data?.unambiguous_ids ?? [])
    return {
      cases,
      queue,
      hubRowLine: hubLines.row,
      /** Видимые случаи в порядке очереди: куда уходит фокус после решения. */
      inOrder: groups.flatMap((group) => group.cases),
      unambiguous: cases.filter((entry) => unambiguousIds.has(entry.id) && isOpenCase(entry)),
      weeks: weekOptions(cases),
    }
  }, [integrations, list.data, model, now, page, rows, unverifiedState, week])

  const canCheckUpload = useCallback(
    (account: AccountCode) => hubCanCheck(integrations, model, account),
    [integrations, model],
  )
  const toggleUnverified = () =>
    setUnverifiedState((current) => ({ ...current, open: !current.open }))
  const toggleReason = (reason: string) =>
    setUnverifiedState((current) => ({
      ...current,
      reasons: current.reasons.includes(reason)
        ? current.reasons.filter((item) => item !== reason)
        : [...current.reasons, reason],
    }))

  return {
    list,
    ...derived,
    hubUpdatedAt: hubUpdatedAt(integrations, model),
    /** «Проверить заливку» только там, где Hub включён и настроен. */
    canCheckUpload,
    toggleUnverified,
    toggleReason,
  }
}
