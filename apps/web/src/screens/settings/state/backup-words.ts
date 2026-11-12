import {
  formatBytes,
  formatWhen,
  type Instant,
  instantMs,
  type SystemState,
} from '@contentops/contracts'

/**
 * Бэкап словами (§4.19; пакет N, 12.11.2026): копия базы — когда снята и где лежит, с
 * предупреждением, если она старше 36 ч; мастера и загрузки — что копии у них нет, на той же
 * строке. После бэкапа внутри продукта «последняя полная точка» встаёт рядом.
 */
export function backupWords(
  backup: SystemState['backup'],
  now: Instant,
): { value: string; detail?: string; warning: boolean } {
  const uncovered =
    backup.uncovered_bytes === null
      ? null
      : `мастера и загрузки${backup.uncovered_bytes > 0 ? ` (${formatBytes(backup.uncovered_bytes)})` : ''} — копии нет`
  const full = backup.last_full_at ? `полная точка ${formatWhen(backup.last_full_at, now)}` : null
  if (!backup.last_dump_at) {
    return {
      value: backup.text,
      detail: [full, uncovered].filter(Boolean).join(' · ') || undefined,
      warning: true,
    }
  }
  const hours = (instantMs(now) - instantMs(backup.last_dump_at)) / 3_600_000
  const stale = hours > backup.stale_after_hours
  const when = formatWhen(backup.last_dump_at, now)
  return {
    value: stale
      ? `Копия базы старше ${backup.stale_after_hours} ч: ${when}`
      : `Копия базы: ${when}`,
    detail: [backup.dump_where, full, uncovered].filter(Boolean).join(' · ') || undefined,
    warning: stale,
  }
}
