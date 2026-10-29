import { formatWhen, type Instant, type SystemState } from '@contentops/contracts'

/**
 * Бэкап словами (§4.19): в пилоте — «Бэкапа нет (пилот)»; после запуска «последняя
 * полная точка» стоит отдельно от «последнего дампа».
 */
export function backupWords(
  backup: SystemState['backup'],
  now: Instant,
): { value: string; detail?: string } {
  if (!backup.last_full_at && !backup.last_dump_at) {
    return { value: backup.text }
  }
  const full = backup.last_full_at ? formatWhen(backup.last_full_at, now) : 'не было'
  const dump = backup.last_dump_at ? formatWhen(backup.last_dump_at, now) : 'не было'
  return { value: `полная точка ${full}`, detail: `последний дамп ${dump}` }
}
