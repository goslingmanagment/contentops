/**
 * Чистые операции над выделением (DESIGN §3.3): клик, `Ctrl`/`⌘` — точечно,
 * `Shift` — диапазон от опорной строки. Выделение хранится ключами объектов.
 */

export function selectOnly(keys: readonly string[], index: number): Set<string> {
  const key = keys[index]
  return key === undefined ? new Set() : new Set([key])
}

export function toggleKey(selected: ReadonlySet<string>, key: string | undefined): Set<string> {
  const next = new Set(selected)
  if (key === undefined) {
    return next
  }
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  return next
}

/** Диапазон от `anchor` до `target` включительно; с `keep` добавляется к прежнему. */
export function selectRange(
  keys: readonly string[],
  anchor: number,
  target: number,
  keep: ReadonlySet<string> = new Set(),
): Set<string> {
  const next = new Set(keep)
  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor]
  for (let index = from; index <= to; index += 1) {
    const key = keys[index]
    if (key !== undefined) {
      next.add(key)
    }
  }
  return next
}

export function clampIndex(index: number, count: number): number {
  if (count === 0) {
    return 0
  }
  return Math.min(count - 1, Math.max(0, index))
}
