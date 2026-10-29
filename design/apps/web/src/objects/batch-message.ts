import { type BatchResult, formatNumber } from '@contentops/contracts'

/**
 * Итог пакета «по каждой записи» одной полоской (DESIGN §3.3): «Теги изменены · 7» или
 * «Теги изменены · 6 из 7 · 1 уже удалили».
 */
export function batchMessage(result: BatchResult, done: string): string {
  const total = result.results.length
  const ok = result.results.filter((entry) => entry.ok).length
  if (ok === total) {
    return `${done} · ${formatNumber(total)}`
  }
  return `${done} · ${formatNumber(ok)} из ${formatNumber(total)} · ${formatNumber(total - ok)} уже удалили`
}
