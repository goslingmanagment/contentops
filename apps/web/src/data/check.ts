import {
  type AccountCode,
  type CheckCase,
  type CheckList,
  type LocalDate,
  type ModelCode,
  mskDate,
  type PlacementVerdict,
  type ResolvedCase,
} from '@contentops/contracts'
import { hashKey, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useApi } from './api-session'
import { queryKeys } from './query-keys'

/**
 * «Сверить» (DESIGN §4.15): открытые случаи, решённые, «Не наше» и строки «Hub не смог
 * проверить». Решение человека не выкидывает строку из списка: она сереет на месте с
 * новым словом от сервера (§1, п. 7), а уходит в «Решённые» при следующей загрузке.
 */

export type ClosedView = 'done' | 'not-ours'

/** Случай ещё ждёт человека: у него знак ◆. */
export function isOpenCase(entry: CheckCase): boolean {
  return entry.verdict.sign === 'turn'
}

/** Только то, что ждёт человека: без строк, которые уже решили, но ещё не перечитали. */
function openCases(list: CheckList): CheckList {
  const items = list.items.filter(isOpenCase)
  return items.length === list.items.length ? list : { ...list, items }
}

function keepList(list: CheckList): CheckList {
  return list
}

function useOpenList(model: ModelCode, select: (list: CheckList) => CheckList) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.checkCases(model, 'open'),
    queryFn: ({ signal }) => api.check.list({ params: { model }, signal }),
    select,
  })
}

/**
 * Открытые случаи для всего, что вне очереди «Сверить»: число на вкладке шапки Плана
 * (`items.length`) и ◆ пары в панели дня. Решённый случай выпадает отсюда сразу, ещё до
 * перечитывания списка, поэтому число одно и то же в Дне, Неделе и самой «Сверить».
 */
export function useCheckList(model: ModelCode) {
  return useOpenList(model, openCases)
}

/**
 * Очередь вкладки «Сверить» как её прислал сервер: решённая строка стоит на месте серой
 * до следующей загрузки (§1, п. 7). Тот же кэш, что у `useCheckList`.
 */
export function useCheckQueueList(model: ModelCode) {
  return useOpenList(model, keepList)
}

/**
 * Куда ведёт «Hub видел 1 пост без плана · Сверить» из дня (DESIGN §4.11): открытые «пост
 * без плана» этой страницы, вышедшие в этот день. Один — сразу на его адрес.
 */
export function unplannedCaseIds(
  list: CheckList | undefined,
  account: AccountCode,
  date: LocalDate,
): string[] {
  return (list?.items ?? [])
    .filter(
      (entry) =>
        entry.kind === 'unplanned' &&
        entry.account === account &&
        isOpenCase(entry) &&
        entry.posts.some((post) => mskDate(post.post_at) === date),
    )
    .map((entry) => entry.id)
}

/** «Решённые за 14 дней» (`?show=done`) и «Не наше» (`?show=not-ours`). */
export function useClosedCases(model: ModelCode, show: ClosedView, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.checkCases(model, show),
    queryFn: ({ signal }) =>
      show === 'done'
        ? api.check.resolved({ params: { model }, signal })
        : api.check.notOurs({ params: { model }, signal }),
    select: (page): readonly ResolvedCase[] => page.items,
    enabled,
  })
}

/** Один случай по адресу `/<модель>/plan/check/<id>`; решённый отвечает 422. */
export function useCheckCase(model: ModelCode, id: string, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.checkCase(model, id),
    queryFn: ({ signal }) => api.check.get({ params: { model, case: id }, signal }),
    enabled,
  })
}

/** Строки «Hub не смог проверить» грузятся только по «Почему». */
export function useUnverifiedRows(model: ModelCode, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.checkCases(model, 'unverified'),
    queryFn: ({ signal }) => api.check.unverified({ params: { model }, signal }),
    select: (page) => page.items,
    enabled,
  })
}

function patchCases(
  list: CheckList | undefined,
  patch: (entry: CheckCase) => CheckCase,
): CheckList | undefined {
  if (!list) {
    return list
  }
  const items = list.items.map(patch)
  const open = new Set(items.filter(isOpenCase).map((entry) => entry.id))
  return {
    ...list,
    items,
    unambiguous_ids: list.unambiguous_ids.filter((id) => open.has(id)),
  }
}

/** Какой список сейчас на экране: его не перезапрашиваем, чтобы строки не прыгали. */
export type CheckView = 'open' | ClosedView

export interface CheckSync {
  /**
   * Сервер ответил новым словом. Итог — строка сереет на месте; снова ◆ (отмена, ответ на
   * один из вариантов) — берётся свежий вид случая.
   */
  apply(caseId: string, verdict: PlacementVerdict): Promise<void>
  /**
   * Всё остальное у модели могло измениться: план, «где залито», журнал, счётчики. Список
   * на экране (`visible`) не перечитывается, чтобы строки не прыгали, а только помечается
   * устаревшим — следующая загрузка берёт его заново; `null` — перечитать всё.
   */
  refresh(visible: CheckView | null): void
  /** Случай решил кто-то другой: открытый список перечитывается целиком. */
  reload(): void
  /** Стоит ли случай в открытом списке сейчас (по кэшу на момент вызова, а не рендера). */
  isListed(caseId: string): boolean
}

/** Правка списка случаев только ответом сервера — «сохранено» не рисуется заранее (§3.13). */
export function useCheckSync(model: ModelCode): CheckSync {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMemo(() => {
    const openKey = queryKeys.checkCases(model, 'open')
    const patchOpen = (patch: (entry: CheckCase) => CheckCase) =>
      queryClient.setQueryData<CheckList>(openKey, (list) => patchCases(list, patch))
    const inOpenList = (caseId: string) =>
      queryClient.getQueryData<CheckList>(openKey)?.items.some((entry) => entry.id === caseId)

    const reopen = async (caseId: string) => {
      if (!inOpenList(caseId)) {
        await queryClient.invalidateQueries({ queryKey: openKey })
        return
      }
      const fresh = await api.check.get({ params: { model, case: caseId } })
      patchOpen((entry) => (entry.id === caseId ? fresh : entry))
    }

    return {
      apply: async (caseId, verdict) => {
        if (verdict.sign === 'turn') {
          await reopen(caseId)
          return
        }
        patchOpen((entry) => (entry.id === caseId ? { ...entry, verdict } : entry))
      },
      refresh: (visible) => {
        const visibleKey = visible ? queryKeys.checkCases(model, visible) : null
        const keep = visibleKey ? hashKey(visibleKey) : null
        void queryClient.invalidateQueries({
          queryKey: queryKeys.model(model),
          predicate: (query) => query.queryHash !== keep,
        })
        if (visibleKey) {
          // Список на экране не перечитывается сейчас, но устаревает: День, Неделя и
          // возврат во вкладку берут его свежим, решённое уходит в «Решённые».
          void queryClient.invalidateQueries({ queryKey: visibleKey, refetchType: 'none' })
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.counters() })
      },
      reload: () => void queryClient.invalidateQueries({ queryKey: openKey }),
      isListed: (caseId) => inOpenList(caseId) ?? false,
    }
  }, [api, model, queryClient])
}
