import type { CheckList, ModelCode } from '@contentops/contracts'
import { useCheckCase } from '@/data/check'

/**
 * Случай из адреса `/<модель>/plan/check/<id>`, которого нет в очереди: спрашиваем сервер,
 * что с ним. Решённый отвечает 422, чужой или выдуманный — 404. Ответ идёт в `CaseNotice`;
 * `null` — случай в очереди, адрес без случая или ответа ещё нет.
 */
export function useMissingCase(
  model: ModelCode,
  caseId: string | undefined,
  list: CheckList | undefined,
): unknown | null {
  const listed = caseId !== undefined && list?.items.some((entry) => entry.id === caseId)
  const wanted = caseId !== undefined && list !== undefined && !listed
  const lookup = useCheckCase(model, caseId ?? '', wanted)
  return wanted && lookup.isError ? lookup.error : null
}
