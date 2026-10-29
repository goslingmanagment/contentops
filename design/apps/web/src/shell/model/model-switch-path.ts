import type { ModelCode } from '@contentops/contracts'

/** Режимы прототипа (`?demo=`, `?as=`) остаются всегда. */
const SESSION_SEARCH = ['demo', 'as'] as const
/** Вид раздела значит одно и то же у любой модели. */
const VIEW_SEARCH = ['view', 'variant'] as const

/**
 * Куда вести при смене модели (DESIGN §2.2): в тот же раздел другой модели. Список, день,
 * неделя, вкладка — тот же адрес; запись из адреса (объект, файл, заказ, случай, группа
 * «Приехало», канал промо, настройки страницы) у другой модели своя, поэтому — корень
 * раздела. Фильтры и сортировка ссылаются на страницы модели и не переносятся; вид
 * раздела (`view`, `variant`) переносится.
 */
export function modelSwitchHref(
  pathname: string,
  search: Readonly<Record<string, unknown>>,
  model: ModelCode,
): string {
  const [, , section, ...rest] = pathname.split('/')
  const path = sectionPath(section, rest)
  const query = new URLSearchParams()
  const kept = path.keepsSearch ? [...VIEW_SEARCH, ...SESSION_SEARCH] : SESSION_SEARCH
  for (const key of kept) {
    const value = search[key]
    if (typeof value === 'string') {
      query.set(key, value)
    }
  }
  const tail = query.size > 0 ? `?${query.toString()}` : ''
  return `/${model}/${path.path}${tail}`
}

function sectionPath(
  section: string | undefined,
  rest: readonly string[],
): { path: string; keepsSearch: boolean } {
  const same = { path: [section, ...rest].join('/'), keepsSearch: true }
  switch (section) {
    case 'i':
    case 'a':
      return { path: 'library', keepsSearch: false }
    case 'library':
      if (rest[0] === 'customs' && rest[1] === 'orders') {
        return { path: 'library/customs', keepsSearch: false }
      }
      if (rest[0] === 'promo' && rest.length > 1) {
        return { path: 'library/promo', keepsSearch: false }
      }
      return same
    case 'inbox':
      return rest[0] === 'g' ? { path: 'inbox', keepsSearch: false } : same
    case 'plan':
      return rest[0] === 'check' && rest.length > 1
        ? { path: 'plan/check', keepsSearch: false }
        : same
    case 'journal':
    case 'search':
      return { path: section, keepsSearch: false }
    default:
      // Настройки страницы модели и всё неизвестное — Библиотека другой модели.
      return { path: 'library', keepsSearch: false }
  }
}
