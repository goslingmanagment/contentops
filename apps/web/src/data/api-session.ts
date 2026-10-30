import {
  type ApiClient,
  type Clock,
  createApiClient,
  type FetchLike,
  isApiError,
  type LocalDate,
  mskDate,
  systemClock,
} from '@contentops/contracts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { type ServerFile, saveServerFile } from '@/lib/save-file'
import { devMock } from './dev-mock'
import { isServerRoute } from './server-routes'

/**
 * Сеанс данных: часы, клиент API и кэш запросов. Всё живёт, пока не сменились `?demo=` и
 * `?as=`; смена даёт новый сеанс с чистым кэшем.
 */
export interface ApiSession {
  client: ApiClient
  clock: Clock
  queryClient: QueryClient
  demo: string | null
  role: string | null
  /**
   * Единственный путь выдачи файла браузеру: «Скачать» везде, где сервер дал ссылку. У
   * заглушки файлов нет — по ссылке она отдаёт текстовый образец; с настоящим сервером это
   * `saveServerFile`.
   */
  saveFile: (file: ServerFile) => void
  /**
   * Клиент самой заглушки, мимо `SERVER_ROUTES` (только в разработке): загрузка в строку
   * плана, пока план на заглушке, отвечает ей же. В сборке продукта — `null`.
   */
  mockClient: ApiClient | null
}

interface ApiSessionOptions {
  /** `?demo=` и `?as=` — переключатели заглушки в разработке; на пути сервера не влияют. */
  demo: string | null
  role: string | null
  /** 401 от любого запроса ведёт на вход. */
  onUnauthenticated: () => void
}

/** Настоящий сервер: тот же origin, с cookie сеанса. */
const serverFetch: FetchLike = (input, init) =>
  window.fetch(input, { ...init, credentials: 'same-origin' })

/** Ошибки правил и доступа не повторяются; сбой сервера — один повтор. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status < 500) {
    return false
  }
  return failureCount < 1
}

/**
 * В разработке путь идёт на сервер, только если он есть в `SERVER_ROUTES`, остальное —
 * в заглушку; в сборке продукта заглушки нет и всё идёт на сервер.
 */
export function createApiSession({ demo, role, onUnauthenticated }: ApiSessionOptions): ApiSession {
  const mock = devMock()?.(demo, role) ?? null
  const fetchImpl: FetchLike = mock
    ? (input, init, route) =>
        route && isServerRoute(route) ? serverFetch(input, init) : mock.fetch(input, init)
    : serverFetch
  const client = createApiClient(fetchImpl)
  const toLoginOn401 = (error: unknown) => {
    if (isApiError(error) && error.status === 401) {
      onUnauthenticated()
    }
  }
  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: toLoginOn401 }),
    mutationCache: new MutationCache({ onError: toLoginOn401 }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: 400,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
  return {
    client,
    clock: mock?.clock ?? systemClock,
    queryClient,
    demo,
    role,
    saveFile: mock?.saveFile ?? saveServerFile,
    mockClient: mock ? createApiClient((input, init) => mock.fetch(input, init)) : null,
  }
}

export const ApiSessionContext = createContext<ApiSession | null>(null)

function useApiSession(): ApiSession {
  const session = useContext(ApiSessionContext)
  if (!session) {
    throw new Error('ApiSessionContext не подключён: экран вне ApiProvider')
  }
  return session
}

/** Клиент API: экраны зовут его только из хуков `src/data`. */
export function useApi(): ApiClient {
  return useApiSession().client
}

/** «Сейчас»: настоящее время; у заглушки — 22.09.2026 14:20 МСК и дальше по настоящему времени. */
export function useClock(): Clock {
  return useApiSession().clock
}

/**
 * Сегодня по Москве — опора правила дат на всё приложение: дата текущего года — «22.09»,
 * другого — «22.09.2025» (`formatDate(date, today)`).
 */
export function useToday(): LocalDate {
  return mskDate(useClock().now())
}

/** Клиент заглушки для экранов, что ещё на ней; `null` с настоящим сервером в продукте. */
export function useMockApi(): ApiClient | null {
  return useApiSession().mockClient
}

/** «Скачать» готового файла: архив дня, копия для платформы, передача. */
export function useSaveFile(): (file: ServerFile) => void {
  return useApiSession().saveFile
}
