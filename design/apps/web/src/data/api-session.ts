import {
  type ApiClient,
  type Clock,
  createApiClient,
  createMockFetch,
  createPrototypeClock,
  type DemoMode,
  isApiError,
  type LocalDate,
  mskDate,
  type PrototypeRole,
} from '@contentops/contracts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { prototypeFileSaver, type ServerFile } from '@/lib/save-file'

/**
 * Сеанс данных прототипа: часы, клиент API поверх заглушки и кэш запросов. Всё живёт,
 * пока не сменились `?demo=` и `?as=`; смена даёт новый сеанс с чистым кэшем.
 */
export interface ApiSession {
  client: ApiClient
  clock: Clock
  queryClient: QueryClient
  demo: DemoMode | null
  role: PrototypeRole
  /**
   * Единственный путь выдачи файла браузеру: «Скачать» везде, где сервер дал ссылку. У
   * заглушки файлов нет — по ссылке она отдаёт текстовый образец (`prototypeFileSaver`);
   * с настоящим сервером это `saveServerFile`.
   */
  saveFile: (file: ServerFile) => void
}

interface ApiSessionOptions {
  demo: DemoMode | null
  role: PrototypeRole
  /** 401 от любого запроса ведёт на вход. */
  onUnauthenticated: () => void
}

/** Ошибки правил и доступа не повторяются; сбой сервера — один повтор. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status < 500) {
    return false
  }
  return failureCount < 1
}

export function createApiSession({ demo, role, onUnauthenticated }: ApiSessionOptions): ApiSession {
  const clock = createPrototypeClock()
  const mockFetch = createMockFetch({ demo, role, clock })
  const client = createApiClient(mockFetch)
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
  return { client, clock, queryClient, demo, role, saveFile: prototypeFileSaver(mockFetch) }
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

/** «Сейчас» прототипа: 22.09.2026 14:20 МСК и дальше по настоящему времени. */
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

/** «Скачать» готового файла: архив дня, копия для платформы, передача. */
export function useSaveFile(): (file: ServerFile) => void {
  return useApiSession().saveFile
}
