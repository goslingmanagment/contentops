import { z } from 'zod'

/**
 * Только свой путь и после нормализации адреса: без `\`, управляющих символов и пробелов, без пустых
 * (`//`, `/%2F/`) и точечных (`/./`, `/../`) сегментов — `/.//host` браузер сворачивает в `//host`, чужой сайт.
 * Та же таблица, что у сервера (`ownPath`), хаба, TaskIndex и монитора.
 */
export function isOwnPath(from: string): boolean {
  if (!from.startsWith('/') || /[\\\s\p{Cc}]/u.test(from)) return false
  const path = from.split(/[?#]/, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return false
  }
  return [path, decoded].every(
    (form) =>
      !/[\\\s\p{Cc}]/u.test(form) && !form.includes('//') && !/(^|\/)\.{1,2}(\/|$)/.test(form),
  )
}

/**
 * После входа — тот же адрес (DESIGN §3.10): `/login?from=/lora/library/ppv?kind=dm`.
 * Только свой путь (`isOwnPath`).
 */
export const loginSearchSchema = z.object({
  from: z.string().refine(isOwnPath, 'Только свой адрес').optional().catch(undefined),
  /** Вход через хаб не открыл сессию (SPEC §11.1): почему — сервер пишет сюда. */
  hub: z.enum(['no_access', 'failed', 'unreachable']).optional().catch(undefined),
})
