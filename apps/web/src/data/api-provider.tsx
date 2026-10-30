import { QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { type ApiSession, ApiSessionContext, createApiSession } from './api-session'

interface ApiProviderProps {
  demo: string | null
  role: string | null
  onUnauthenticated: () => void
  children: ReactNode
}

/**
 * Подключает клиент API и кэш запросов; `?demo=` и `?as=` уходят в заглушку, если она
 * подключена (только в разработке). Сеанс живёт в состоянии, а не в `useMemo`: заглушка
 * хранит правки, их нельзя терять при случайном пересчёте. Смена `?demo=` или `?as=` —
 * новый сеанс с чистым кэшем.
 */
export function ApiProvider({ demo, role, onUnauthenticated, children }: ApiProviderProps) {
  const unauthenticated = useRef(onUnauthenticated)
  useEffect(() => {
    unauthenticated.current = onUnauthenticated
  }, [onUnauthenticated])

  const create = (): ApiSession =>
    createApiSession({ demo, role, onUnauthenticated: () => unauthenticated.current() })
  const [session, setSession] = useState(create)
  if (session.demo !== demo || session.role !== role) {
    setSession(create())
  }
  useEffect(() => () => session.queryClient.clear(), [session])

  return (
    <ApiSessionContext value={session}>
      <QueryClientProvider client={session.queryClient}>{children}</QueryClientProvider>
    </ApiSessionContext>
  )
}
