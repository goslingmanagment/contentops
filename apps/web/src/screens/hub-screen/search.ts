/**
 * The query of «Публикации» and «Статистика» (products plan §2.4): Hub's own screen inside the frame
 * keeps its place in its address (`?page=lora-1&publication=12&period=30d`), and ContentOps mirrors it
 * into its own, so «Назад», a reload and a link keep the place. Taken as it is: text values only.
 */
export type HubScreenSearch = Record<string, string | number | boolean>

/** Text, numbers and switches as the router read them (a number stays a number: `?publication=12`). */
export function hubScreenSearchSchema(raw: Record<string, unknown>): HubScreenSearch {
  const out: HubScreenSearch = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

/** Hub's query as ContentOps' router keeps it: a number written as one, so the address stays plain. */
export function routerSearch(query: URLSearchParams): HubScreenSearch {
  const out: HubScreenSearch = {}
  for (const [key, value] of query.entries()) {
    out[key] =
      value !== '' && /^-?\d{1,15}$/.test(value) && String(Number(value)) === value
        ? Number(value)
        : value
  }
  return out
}

/** ContentOps' own parameters (the demo, the role, the skin): never Hub's screen's. */
const OWN = new Set(['demo', 'as', 'skin'])

/** The query Hub's screen is opened with: the mirrored one, without ContentOps' own. */
export function innerQuery(search: HubScreenSearch): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (!OWN.has(key) && key !== 'model') query.set(key, String(value))
  }
  return query
}

/** The same query as Hub's screen says it (`?a=1&b=2`): the mirrored search, sorted for comparison. */
export function sameQuery(a: URLSearchParams, b: URLSearchParams): boolean {
  const sorted = (query: URLSearchParams) =>
    [...query.entries()].sort(([x], [y]) => x.localeCompare(y)).join('&')
  return sorted(a) === sorted(b)
}
