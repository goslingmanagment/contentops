/**
 * Запрос до «#» (`index.html?as=owner#/lora/library/ppv?kind=dm`): так адрес получается,
 * если режим прототипа дописали руками в конец пути файла. Маршрутизатор на hash-адресах
 * приклеивал бы его к запросу хэша (`?kind=dm?as=owner`) и терял бы оба. Поэтому до
 * старта параметры переносятся внутрь хэша — `#/lora/library/ppv?kind=dm&as=owner`;
 * при совпадении имени побеждает хэш.
 */
export function hashWithOuterQuery(search: string, hash: string): string | null {
  const outer = new URLSearchParams(search)
  if (outer.size === 0) {
    return null
  }
  const route = hash.replace(/^#/, '') || '/'
  const queryStart = route.indexOf('?')
  const path = queryStart < 0 ? route : route.slice(0, queryStart)
  const inner = new URLSearchParams(queryStart < 0 ? '' : route.slice(queryStart + 1))
  for (const [name, value] of outer) {
    if (!inner.has(name)) {
      inner.append(name, value)
    }
  }
  const query = inner.toString()
  return `#${path}${query ? `?${query}` : ''}`
}

/** Переносит запрос до «#» внутрь хэша, не создавая записи в истории. */
export function moveOuterQueryIntoHash(win: Window): void {
  const hash = hashWithOuterQuery(win.location.search, win.location.hash)
  if (hash !== null) {
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${hash}`)
  }
}
