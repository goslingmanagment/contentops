/**
 * «Вышел»: the post's number on the platform, as Hub takes it (`platformPostRef`: digits and Latin letters, `_`, `-`,
 * up to 64). A person may paste the post's link instead: Fansly's `fansly.com/post/<номер>`, OnlyFans'
 * `onlyfans.com/<номер>/<страница>`. Null — neither a number nor such a link.
 */
const REF = /^[0-9A-Za-z_-]{1,64}$/

export function postRefOf(text: string): string | null {
  const value = text.trim()
  if (value === '') return null
  if (REF.test(value)) return value
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  if (host === 'fansly.com' && parts[0] === 'post' && parts[1] && REF.test(parts[1]))
    return parts[1]
  if (host === 'onlyfans.com' && parts[0] && /^\d{1,64}$/.test(parts[0])) return parts[0]
  return null
}
