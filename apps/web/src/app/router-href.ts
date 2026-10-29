/**
 * Адрес для `router.navigate({ href })`, если ссылка ведёт внутрь приложения, иначе `null`
 * (чужой сайт, другой документ — пусть браузер переходит сам).
 *
 * Внутренняя ссылка узнаётся тремя способами, чтобы переход без перезагрузки работал и на
 * hash-адресах прототипа, и на `createBrowserHistory` продукта (DESIGN §9.1):
 * - `#/lora/plan` или `index.html?x#/lora/plan` — hash того же документа;
 * - `/lora/plan?view=week` — путь от корня того же сайта;
 * - `https://тот-же-сайт/lora/plan` — полный адрес с тем же origin.
 */
export function routerHrefOf(href: string, current: string): string | null {
  let target: URL
  let here: URL
  try {
    here = new URL(current)
    target = new URL(href, here)
  } catch {
    return null
  }
  // У file:// и mailto: origin одинаково «null», поэтому сверяется и протокол.
  if (target.protocol !== here.protocol || target.origin !== here.origin) {
    return null
  }
  if (target.hash.startsWith('#/')) {
    // Hash-адрес ведёт внутрь, только если документ тот же: иначе это другой сайт на hash.
    return target.pathname === here.pathname ? target.hash.slice(1) : null
  }
  const rooted = href.startsWith('/') && !href.startsWith('//')
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(href)
  if (!rooted && !absolute) {
    // «plan», «../x», «?q=1»: относительные адреса приложение не строит.
    return null
  }
  return `${target.pathname}${target.search}${target.hash}`
}
