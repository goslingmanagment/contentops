import type { BatchResult } from '@contentops/contracts'

/**
 * ID записей пакета, которые не прошли (DESIGN §3.3): для «Показать» в итоговой полоске —
 * выделить непрошедшие.
 */
export function failedIds(result: BatchResult): string[] {
  return result.results.filter((entry) => !entry.ok).map((entry) => entry.id)
}
