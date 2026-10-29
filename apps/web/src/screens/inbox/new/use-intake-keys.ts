import { hasModifierKey, isTypingTarget } from '@contentops/ui/lib/platform'
import { type KeyboardEvent, type RefObject, useCallback } from 'react'
import type { DraftPanelHandle } from '../panel/draft-panel'
import type { InboxView } from '../search'
import { type IntakeSection, type Step, stepIndex } from './intake-sections'
import type { IntakeSelection } from './use-intake-selection'

const STEP_BY_CODE: Readonly<Record<string, Step>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
}

/** Число колонок CSS-сетки плиток по её вычисленному шаблону. */
function columnsOf(list: HTMLElement | null, view: InboxView): number {
  const grid = list?.querySelector<HTMLElement>('[data-intake-grid]')
  if (!grid || view === 'list') {
    return 1
  }
  return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
}

interface IntakeKeysOptions {
  listRef: RefObject<HTMLDivElement | null>
  sections: readonly IntakeSection[]
  view: InboxView
  selection: IntakeSelection
  panelRef: RefObject<DraftPanelHandle | null>
  onPreview: () => void
}

/**
 * Клавиши списка «Приехало» (DESIGN §3.12, §4.8): стрелки — группы, `Shift` — диапазон,
 * `1` — принять, `2` — дополнить, `3` — отклонить, `Space` — просмотр, `Enter` — фокус в
 * панель, `Ctrl A` — всё, `Esc` — оставить одну. Цифры действуют, только когда фокус в
 * списке; слушаются по `code`, поэтому работают и в русской раскладке.
 */
export function useIntakeKeys({
  listRef,
  sections,
  view,
  selection,
  panelRef,
  onPreview,
}: IntakeKeysOptions) {
  return useCallback(
    (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.altKey) {
        return
      }
      const step = STEP_BY_CODE[event.code]
      if (step) {
        event.preventDefault()
        const sizes = sections.map((section) => section.groups.length)
        const columns = columnsOf(listRef.current, view)
        selection.focusAt(stepIndex(sizes, columns, selection.focusIndex, step), event.shiftKey)
        return
      }
      if (event.code === 'KeyA' && hasModifierKey(event)) {
        event.preventDefault()
        selection.selectKeys(sections.flatMap((section) => section.groups.map((group) => group.id)))
        return
      }
      if (hasModifierKey(event)) {
        return
      }
      const single = selection.current !== null
      const commands: Readonly<Record<string, (() => void) | undefined>> = {
        Escape: selection.selectedKeys.size > 1 ? selection.collapse : undefined,
        Digit1: single ? () => panelRef.current?.primary() : undefined,
        Digit2: single ? () => panelRef.current?.second('list') : undefined,
        Digit3: single ? () => panelRef.current?.reject('list') : undefined,
        Space: single ? onPreview : undefined,
        Enter: single ? () => panelRef.current?.focus() : undefined,
      }
      const command = commands[event.code]
      if (command) {
        event.preventDefault()
        command()
      }
    },
    [listRef, onPreview, panelRef, sections, selection, view],
  )
}
