import type { InboxGroup } from '@contentops/contracts'
import { hasModifierKey } from '@contentops/ui/lib/platform'
import { selectRange, toggleKey } from '@contentops/ui/lib/selection'
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useHistoryState } from '@/lib/use-history-state'
import { nextAfterRemoval } from './intake-sections'

const KeysSchema = z.array(z.string())
const FocusSchema = z.string().nullable()

interface SelectionOptions {
  /** Все группы «Нового» в порядке экрана. */
  groups: readonly InboxGroup[]
  /** Куда встать, если выбранного нет: группа из адреса или первая, где можно действовать. */
  fallbackKey: string | null
  /**
   * `false` — пока ничего не выбрано, не выбирать самим: группы из адреса нет, и панель
   * говорит об этом, а не молча показывает другую (DESIGN §3.10).
   */
  autoSelect?: boolean
}

export interface IntakeSelection {
  selectedKeys: ReadonlySet<string>
  focusKey: string | null
  focusIndex: number
  /** Одна выбранная группа — её показывает панель; при нескольких — `null`. */
  current: InboxGroup | null
  selectedGroups: readonly InboxGroup[]
  click: (index: number, event: MouseEvent) => void
  /** Галочка на плитке: выбор без открытия. */
  toggle: (key: string) => void
  focusAt: (index: number, extend: boolean) => void
  selectKeys: (keys: readonly string[]) => void
  /** `Esc`: из нескольких выбранных остаётся та, где фокус. */
  collapse: () => void
}

/**
 * Выделение в «Приехало» (DESIGN §3.3): клик — одна группа в панели, `Shift` — диапазон,
 * `Ctrl`/`⌘` — точечно. Выделение и фокус живут в `history.state`, «Назад» их
 * возвращает. Пока группы есть, выбрана хотя бы одна: ушедшую после решения сменяет
 * следующая.
 */
export function useIntakeSelection({
  groups,
  fallbackKey,
  autoSelect = true,
}: SelectionOptions): IntakeSelection {
  const [selected, setSelected] = useHistoryState('inbox:selected', KeysSchema, () => [])
  const [focusKey, setFocusKey] = useHistoryState('inbox:focus', FocusSchema, () => null)
  const [anchorKey, setAnchorKey] = useState<string | null>(focusKey)
  const keys = useMemo(() => groups.map((group) => group.id), [groups])
  const previousOrder = useRef<readonly string[]>(keys)

  useEffect(() => {
    const previous = previousOrder.current
    previousOrder.current = keys
    if (keys.length === 0) {
      return
    }
    const present = new Set(keys)
    const kept = selected.filter((key) => present.has(key))
    if (kept.length > 0) {
      if (kept.length < selected.length) {
        setSelected(kept)
      }
      if (focusKey === null || !present.has(focusKey)) {
        setFocusKey(kept[0] ?? null)
      }
      return
    }
    if (!autoSelect && selected.length === 0) {
      return
    }
    const removed = new Set(previous.filter((key) => !present.has(key)))
    const candidate = nextAfterRemoval(previous, removed) ?? fallbackKey
    const target = candidate !== null && present.has(candidate) ? candidate : keys[0]
    if (target !== undefined) {
      setSelected([target])
      setFocusKey(target)
      setAnchorKey(target)
    }
  }, [keys, selected, focusKey, fallbackKey, autoSelect, setSelected, setFocusKey])

  const selectedKeys = useMemo(() => new Set(selected), [selected])
  const selectedGroups = useMemo(
    () => groups.filter((group) => selectedKeys.has(group.id)),
    [groups, selectedKeys],
  )
  const focusIndex = Math.max(0, focusKey === null ? 0 : keys.indexOf(focusKey))

  const focusAt = useCallback(
    (index: number, extend: boolean) => {
      const key = keys[index]
      if (key === undefined) {
        return
      }
      setFocusKey(key)
      if (extend) {
        const anchor = anchorKey === null ? index : Math.max(0, keys.indexOf(anchorKey))
        setSelected([...selectRange(keys, anchor, index)])
        return
      }
      setAnchorKey(key)
      setSelected([key])
    },
    [anchorKey, keys, setFocusKey, setSelected],
  )

  const click = useCallback(
    (index: number, event: MouseEvent) => {
      const key = keys[index]
      if (key === undefined) {
        return
      }
      if (event.shiftKey) {
        focusAt(index, true)
        return
      }
      if (hasModifierKey(event)) {
        setFocusKey(key)
        setAnchorKey(key)
        const next = toggleKey(selectedKeys, key)
        setSelected(next.size > 0 ? [...next] : [key])
        return
      }
      focusAt(index, false)
    },
    [focusAt, keys, selectedKeys, setFocusKey, setSelected],
  )

  const toggle = useCallback(
    (key: string) => {
      const next = toggleKey(selectedKeys, key)
      setSelected(next.size > 0 ? keys.filter((candidate) => next.has(candidate)) : [key])
      setAnchorKey(key)
    },
    [keys, selectedKeys, setSelected],
  )

  const selectKeys = useCallback(
    (next: readonly string[]) => {
      const first = next[0]
      if (first === undefined) {
        return
      }
      setSelected([...next])
      setFocusKey(first)
      setAnchorKey(first)
    },
    [setFocusKey, setSelected],
  )

  const collapse = useCallback(() => {
    const key = focusKey !== null && selectedKeys.has(focusKey) ? focusKey : selected[0]
    if (key !== undefined) {
      setSelected([key])
    }
  }, [focusKey, selected, selectedKeys, setSelected])

  const current = selectedGroups.length === 1 ? (selectedGroups[0] ?? null) : null
  return {
    selectedKeys,
    focusKey,
    focusIndex,
    current,
    selectedGroups,
    click,
    toggle,
    focusAt,
    selectKeys,
    collapse,
  }
}
