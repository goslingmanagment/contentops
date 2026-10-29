import type { ItemFile } from '@contentops/contracts'

/** Файлы в порядке для заливки: по позиции, без позиции — в конце в прежнем порядке. */
export function byPosition(files: readonly ItemFile[]): ItemFile[] {
  return [...files].sort(
    (left, right) =>
      (left.position ?? Number.POSITIVE_INFINITY) - (right.position ?? Number.POSITIVE_INFINITY),
  )
}

/** Кадры сета в порядке съёмки: `ed01`, `ed02`… — ключ несёт исходный номер. */
export function byKey(files: readonly ItemFile[]): ItemFile[] {
  return [...files].sort((left, right) =>
    left.key.localeCompare(right.key, 'en', { numeric: true }),
  )
}
