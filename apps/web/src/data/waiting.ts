import type { ModelCode, Role } from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { useCheckList } from './check'
import { useInboxList } from './inbox'
import { queryKeys } from './query-keys'

/**
 * «Ждут вас» (план продуктов §2.4, §4.4): дела человека из Hub (через его вход через Hub, сервер
 * держит ответ минуту) и свои строки ContentOps — те же чтения, что у шапки Плана («Сверить 8») и
 * у «Приехало» («Нужно решение 1»): одно число в одном месте.
 */
const EVERY_MS = 60_000

export function useHubWaiting(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.waiting(model),
    queryFn: ({ signal }) => api.waiting.list({ params: { model }, signal }),
    refetchInterval: EVERY_MS,
  })
}

export interface OwnLine {
  key: 'check' | 'inbox'
  label: string
  count: number
  to: 'check' | 'inbox'
}

/** Свои строки и общее число; у «Только чтение» и «Только кастомы» своих строк нет. */
export function useWaiting(model: ModelCode, role: Role | null) {
  const staff = role === 'owner' || role === 'manager'
  const hub = useHubWaiting(model)
  const check = useCheckList(model, staff)
  const inbox = useInboxList(model, 'active', staff)
  const own: OwnLine[] = []
  const checks = check.data?.items.length ?? 0
  if (staff && checks > 0) own.push({ key: 'check', label: 'Сверить', count: checks, to: 'check' })
  const decisions = inbox.data?.sections?.decision ?? 0
  if (staff && decisions > 0) {
    own.push({ key: 'inbox', label: 'Приехало: нужно решение', count: decisions, to: 'inbox' })
  }
  const matters = hub.data?.matters ?? []
  return {
    hub,
    own,
    matters,
    total: matters.length + own.reduce((sum, line) => sum + line.count, 0),
  }
}
