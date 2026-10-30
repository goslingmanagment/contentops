/**
 * Адрес для `router.navigate({ href })`, если ссылка ведёт внутрь приложения, иначе `null`
 * (чужой сайт, другой документ — пусть браузер переходит сам).
 *
 * Внутренняя ссылка — путь от корня того же сайта (`/lora/plan?view=week`) или полный
 * адрес с тем же origin (`https://тот-же-сайт/lora/plan`).
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
  const rooted = href.startsWith('/') && !href.startsWith('//')
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(href)
  if (!rooted && !absolute) {
    // «plan», «../x», «?q=1», «#x»: относительные адреса приложение не строит.
    return null
  }
  return `${target.pathname}${target.search}${target.hash}`
}
