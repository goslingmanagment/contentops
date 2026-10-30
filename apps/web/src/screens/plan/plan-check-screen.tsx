import { getRouteApi, useNavigate, useParams } from '@tanstack/react-router'
import type { CheckSearch } from './check/check-view'
import { CheckView } from './check/check-view'

const routeApi = getRouteApi('/_shell/$model/plan/check')

/**
 * План › Сверить `/<модель>/plan/check` (DESIGN §4.15). Выбранный случай живёт в адресе
 * `/<модель>/plan/check/<id>` (§2.4): ссылку можно переслать, «Назад» и обновление
 * открывают тот же случай. Выбор заменяет запись истории, а не добавляет новую.
 */
export function PlanCheckScreen() {
  const search = routeApi.useSearch()
  const { model } = routeApi.useParams()
  const caseId = useParams({ strict: false, select: (params) => params.case ?? null })
  const navigate = useNavigate()

  const go = (next: string | null, nextSearch: CheckSearch, replace: boolean) =>
    void (next
      ? navigate({
          to: '/$model/plan/check/$case',
          params: { model, case: next },
          search: nextSearch,
          replace,
        })
      : navigate({ to: '/$model/plan/check', params: { model }, search: nextSearch, replace }))

  return (
    <CheckView
      search={search}
      caseId={caseId}
      onCaseChange={(next) => go(next, search, true)}
      // «Решённые» и «Не наше» — свой список без панели случая; чипы выбор не снимают.
      onSearchChange={(next) => go(next.show ? null : caseId, next, !next.show)}
    />
  )
}
