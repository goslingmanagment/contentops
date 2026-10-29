/**
 * Чтение и запись `sessionStorage` и `localStorage` без падений: в приватном окне, при
 * запрете сайта или переполнении хранилище бросает исключение, а экран должен работать
 * и без него.
 */

type StorageKind = 'session' | 'local'

function storageOf(kind: StorageKind): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

export function readStored(kind: StorageKind, key: string): string | null {
  try {
    return storageOf(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStored(kind: StorageKind, key: string, value: string): void {
  try {
    storageOf(kind)?.setItem(key, value)
  } catch {
    // Хранилище недоступно: значение просто не запомнится.
  }
}
