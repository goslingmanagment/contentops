/**
 * Ключи того, что стоит на странице объекта, но не файл: кадры мастера и версии фупа.
 * Они живут в выделении и в адресе просмотра рядом с ключами файлов (`ph07`, `master`).
 */

/** Ключ кадра мастера: `frame03`. */
export function frameKey(index: number): string {
  return `frame${String(index + 1).padStart(2, '0')}`
}

/** Версия фупа в адресе просмотра: `?view=version-2`. */
export function fypVersionKey(no: number): string {
  return `version-${no}`
}
