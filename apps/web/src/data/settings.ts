import type { ModelCode } from '@contentops/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * Настройки (DESIGN §4.19). Люди, агенты, пороги, подрядчики и ИИ целиком видит только
 * владелец: остальным эти запросы не отправляются.
 */

interface OwnerOnly {
  /** Запрос уходит, только когда смотрит владелец. */
  enabled?: boolean
}

export function usePeople({ enabled = true }: OwnerOnly = {}) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.people(),
    queryFn: ({ signal }) => api.admin.people({ signal }),
    select: (page) => page.items,
    enabled,
  })
}

/**
 * Имена людей с правами на модель — видит каждый, кому модель открыта: «обычно выкладывает
 * Никита» у КМ. Ключ под `people`: правка прав владельцем перечитывает и его.
 */
export function useModelPeople(model: ModelCode) {
  const api = useApi()
  return useQuery({
    queryKey: [...queryKeys.people(), 'model', model] as const,
    queryFn: ({ signal }) => api.settings.modelPeople({ params: { model }, signal }),
    select: (page) => page.items,
  })
}

/** «Свёрнутая история выдачи прав» — по раскрытию строки человека. */
export function usePersonGrants(person: string, { enabled = true }: OwnerOnly = {}) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.personGrants(person),
    queryFn: ({ signal }) => api.settings.personGrants({ params: { person }, signal }),
    select: (page) => page.items,
    enabled,
  })
}

export function useAgents({ enabled = true }: OwnerOnly = {}) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.agents(),
    queryFn: ({ signal }) => api.admin.agents({ signal }),
    select: (page) => page.items,
    enabled,
  })
}

export function useThresholds({ enabled = true }: OwnerOnly = {}) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.thresholds(),
    queryFn: ({ signal }) => api.admin.thresholds({ signal }),
    select: (page) => page.items,
    enabled,
  })
}

/** «Сервис ИИ»: сервисы, согласия, бюджет и остановка. */
export function useAiSettings({ enabled = true }: OwnerOnly = {}) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.aiSettings(),
    queryFn: ({ signal }) => api.settings.ai({ signal }),
    enabled,
  })
}

/** Очереди и место — живые числа: опрос, пока раздел открыт и вкладка видна (§3.13, п. 8). */
const SYSTEM_STATE_POLL_MS = 10_000

/** «Настройки › Состояние»: очереди, место, бэкап, задержка Hub. */
export function useSystemState() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.systemState(),
    queryFn: ({ signal }) => api.admin.state({ signal }),
    refetchInterval: SYSTEM_STATE_POLL_MS,
  })
}

/** «Профиль и сессии»: свои сессии. */
export function useMySessions() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.mySessions(),
    queryFn: ({ signal }) => api.settings.mySessions({ signal }),
    select: (page) => page.items,
  })
}
